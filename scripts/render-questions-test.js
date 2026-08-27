// One-off: render the real questionsHtml() from main.js with demo data and capture it.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAIN_JS = path.join(__dirname, '..', 'main.js');
function extractFunction(name) {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`could not extract ${name}`);
  return m[0];
}

app.whenReady().then(async () => {
  const escHtml = eval(`(${extractFunction('escHtml')})`);
  const questionItemsOf = eval(`(${extractFunction('questionItemsOf')})`);
  const questionsHtml = eval(`(${extractFunction('questionsHtml')})`);
  const rows = [
    {
      session: { id: 'session_demo1', title: 'Add rate limiting middleware' },
      item: {
        id: 'q1',
        questions: [
          {
            question: 'Which rate limit should apply per API key?',
            header: 'Limits',
            options: [
              { label: '100 req/min', description: 'Standard tier default' },
              { label: '1000 req/min', description: 'Premium tier default' },
            ],
            multi_select: false,
          },
          {
            question: 'Which endpoints need the limiter?',
            header: 'Scope',
            options: [
              { label: '/api/users' },
              { label: '/api/orders' },
              { label: '/api/search' },
            ],
            multi_select: true,
          },
        ],
      },
    },
  ];
  const win = new BrowserWindow({
    width: 640,
    height: 560,
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: true, backgroundThrottling: false },
  });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-q-')), 'q.html');
  fs.writeFileSync(tmp, questionsHtml(rows));
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'screenshots', 'questions.png'), img.toPNG());
  console.log('wrote screenshots/questions.png');
  app.quit();
});
