import fetch from 'node-fetch';
import cheerio from 'cheerio';
import fs from 'fs';
import ini from 'ini';
import { join } from 'path';

const today = new Date();
const day = today.getDate();
const month = today.getMonth() + 1;
const year = today.getFullYear();
const formattedDate = `${day}-${month}-${year}`;

const logFileName = `history_${formattedDate}.txt`;
const logFilePath = join('history', logFileName);

if (!fs.existsSync('history')) {
  fs.mkdirSync('history');
}

const configData = fs.readFileSync('data.ini', 'utf-8');
const config = ini.parse(configData);

const embassies = {
  "en-am-yer": ["en-am", 122, "Continue"],
  "es-co-bog": ["es-co", 25, "Continuar"],
  "en-ca-cal": ["en-ca", 89, "Continue"],
  "en-ca-hal": ["en-ca", 90, "Continue"],
  "en-ca-mon": ["en-ca", 91, "Continue"],
  "en-ca-ott": ["en-ca", 92, "Continue"],
  "en-ca-que": ["en-ca", 93, "Continue"],
  "en-ca-tor": ["en-ca", 94, "Continue"],
  "en-ca-van": ["en-ca", 95, "Continue"],
  // ... (other embassies)
};

const {
  PERSONAL_INFO: { USERNAME, PASSWORD, SCHEDULE_ID, yourEmbassy, startBookingDate, endBookingDate },
  TIME: { RETRY_TIME_L_BOUND, RETRY_TIME_U_BOUND, workingTimeMin, breakTimeMin, BanBreakHour }
} = config;

const embassy = embassies[yourEmbassy][0];
const FACILITY_ID = embassies[yourEmbassy][1];

const issueSleepTime = 2;
const banSeconds = BanBreakHour * 60 * 60;

const BASE_URI = `https://ais.usvisa-info.com/${embassy}/niv`;

async function main(firstLoop = false, shouldLogin = false) {
  while (true) {
    try {
      if (firstLoop) {
        console.log('set time');
        var timeNow = Date.now();
        var endTimeMilliseconds = workingTimeMin * 60 * 1000;
        var endTime = timeNow + endTimeMilliseconds;
      }

      if (shouldLogin) {
        customLog('Computer Starting .... / Logging in...');
        var sessionHeaders = await customLogin();
      }

      firstLoop = false;
      shouldLogin = false;
      var is_booked = false;
      var isIssueGotTime = false;

      customLog('\n //.......//.......//.......//.......//.......//......./\n             logged in successfully          \n');

      const dates = await customCheckAvailableDate(sessionHeaders);
      if (dates == -1) {
        shouldLogin = true;
        continue;
      }

      if (!dates) {
        customLogToFile("No dates available. Probably Banned!!");
        customLogOut(sessionHeaders);
        customLogToFile(`Sleeping for ${BanBreakHour} hours....`);
        await customSleep(banSeconds);
        firstLoop = true;
        shouldLogin = true;
        continue;
      } else {
        customLogToFile(`Available dates:\n${dates}`);

        for (const date of dates.slice(0, 5)) {
          if (date >= startBookingDate && date <= endBookingDate) {
            customLogToFile(`Got the available date: ${date}`);
            const time = await customCheckAvailableTime(sessionHeaders, date);
            if (!time) {
              isIssueGotTime = true;
              break;
            }
            customLog(`Got the available Time: ${time}`);
            const appointment_booked = await customBook(sessionHeaders, date, time);
            if (appointment_booked) {
              customLogToFile(`Appointment of user ${USERNAME} successfully booked at: ${date} ${time}`);
            }
            is_booked = true;
            break;
          }
        }
      }

      if (!is_booked && !isIssueGotTime) {
        customLogToFile(`No date Available between (${startBookingDate} - ${endBookingDate})`);
        const randomSeconds = Math.floor(Math.random() * (parseInt(RETRY_TIME_U_BOUND) - parseInt(RETRY_TIME_L_BOUND) + 1) + parseInt(RETRY_TIME_L_BOUND));
        customLogToFile(`Sleeping for ${randomSeconds} seconds...`);
        await customSleep(randomSeconds);
      }

      if (Date.now() > endTime) {
        customLogToFile(`\nThe Working Time of ${workingTimeMin} minutes Completed!`);
        customLogToFile(`Now Sleeping for ${breakTimeMin} minutes...`);
        const sleepSeconds = breakTimeMin * 60;
        await customSleep(sleepSeconds);
        firstLoop = true;
        shouldLogin = true;
      }
    } catch (err) {
      customLogToFile(`\nError::${err}`);
      customLogToFile("Trying again..");
      shouldLogin = true;
    }
  }
}

// ... (rest of your code)

async function customLogin() {
  while (true) {
    try {
      const anonymousHeaders = await fetch(`${BASE_URI}/users/sign_in`)
        .then(response => {
          if (!response.ok) {
            customLogToFile(response.text());
            throw new Error(`HTTP error! Status: ${response.status}`);
          }
          return customExtractHeaders(response);
        });

      const response = await fetch(`${BASE_URI}/users/sign_in`, {
        "headers": Object.assign({}, anonymousHeaders, {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        }),
        "method": "POST",
        "body": new URLSearchParams({
          'utf8': '✓',
          'user[email]': USERNAME,
          'user[password]': PASSWORD,
          'policy_confirmed': '1',
          'commit': 'Acessar'
        }),
      });

      if (!response.ok) {
        customLogToFile(await response.text());
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const updatedHeaders = Object.assign({}, anonymousHeaders, {
        'Cookie': await customExtractRelevantCookies(response)
      });

      customLogToFile("\nLogin successfully");
      return updatedHeaders;
    } catch (error) {
      customLogToFile(error.message);
      customLogToFile(`\nLogin Failed!! Error: ${error.message}`);
    }
  }
}

async function customCheckAvailableDate(headers, retryCount = 2) {
  while (retryCount > 0) {
    try {
      const response = await fetch(`${BASE_URI}/schedule/${SCHEDULE_ID}/appointment/days/${FACILITY_ID}.json?appointments[expedite]=false`, {
        "headers": Object.assign({}, headers, {
          "Accept": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        }),
        "cache": "no-store"
      });

      if (!response.ok) {
        customLogToFile(await response.text());
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const data = await response.json();

      return data.length > 0 ? data.map(item => item['date']) : null;
    } catch (error) {
      customLogToFile(error.message);
      retryCount -= 1;
    }
  }

  return -1;
}

async function customCheckAvailableTime(headers, date) {
  var retryCount = 3;
  while (retryCount > 0) {
    try {
      const response = await fetch(`${BASE_URI}/schedule/${SCHEDULE_ID}/appointment/times/${FACILITY_ID}.json?date=${date}&appointments[expedite]=false`, {
        method: 'GET',
        headers: {
          ...headers,
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        cache: 'no-store'
      });

      if (!response.ok) {
        customLogToFile(await response.text());
        throw new Error(`Status: ${response.status}`);
      }

      const data = await response.json();

      return data['business_times'][0] || data['available_times'][0];
    } catch (error) {
      customLogToFile(`Error during getting available Time: ${error.message}`);
      retryCount -= 1;
    }
  }
}

async function customBook(headers, date, time) {
  const url = `${BASE_URI}/schedule/${SCHEDULE_ID}/appointment`;

  const newHeaders = await fetch(url, { "headers": headers })
    .then(response => customExtractHeaders(response));

  const response = await fetch(url, {
    "method": "POST",
    "redirect": "follow",
    "headers": Object.assign({}, newHeaders, {
      'Content-Type': 'application/x-www-form-urlencoded',
    }),
    "body": new URLSearchParams({
      'utf8': '✓',
      'authenticity_token': newHeaders['X-CSRF-Token'],
      'confirmed_limit_message': '1',
      'use_consulate_appointment_capacity': 'true',
      'appointments[consulate_appointment][facility_id]': FACILITY_ID,
      'appointments[consulate_appointment][date]': date,
      'appointments[consulate_appointment][time]': time,
      'appointments[asc_appointment][facility_id]': '',
      'appointments[asc_appointment][date]': '',
      'appointments[asc_appointment][time]': ''
    }),
  });

  if (response.ok) {
    const htmlContent = await response.text();
    const titleMatch = /<title[^>]*>(.*?)<\/title>/i.exec(htmlContent);

    if (titleMatch && titleMatch[1]) {
      const titleText = titleMatch[1];
      if (titleText.includes('Confirmation and Instructions')) {
        return true;
      }
    }
  }

  console.error('failed:', response.status);
  return false;
}

async function customExtractHeaders(res) {
  const cookies = customExtractRelevantCookies(res);

  const html = await res.text();
  const $ = cheerio.load(html);
  const csrfToken = $('meta[name="csrf-token"]').attr('content');

  return {
    "Cookie": cookies,
    "X-CSRF-Token": csrfToken,
    "Referer": BASE_URI,
    "Referrer-Policy": "strict-origin-when-cross-origin",
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive'
  };
}

function customExtractRelevantCookies(res) {
  const parsedCookies = customParseCookies(res.headers.get('set-cookie'));
  return `_yatri_session=${parsedCookies['_yatri_session']}`;
}

function customParseCookies(cookies) {
  const parsedCookies = {};

  cookies.split(';').map(c => c.trim()).forEach(c => {
    const [name, value] = c.split('=', 2);
    parsedCookies[name] = value;
  });

  return parsedCookies;
}

function customSleep(s) {
  return new Promise((resolve) => {
    setTimeout(resolve, s * 1000);
  });
}

function customLog(message) {
  console.log(`[${new Date().toISOString()}]`, message);
}

function customLogToFile(message) {
  const stream = fs.createWriteStream(logFilePath, { flags: "a" });

  stream.write(`[${new Date().toISOString()}] ${message}\n`);
  stream.end();
  console.log(`[${new Date().toISOString()}]`, message);
}

function customLogOut(headers) {
  return fetch(`https://ais.usvisa-info.com/${embassy}/niv/users/sign_out`, {
    "headers": Object.assign({}, headers, {
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    }),
    "cache": "no-store",
  })
  .then(() => customLogToFile("Account logged out!"));
}

main(true, true);
