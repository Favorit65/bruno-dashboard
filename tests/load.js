// Загружает две копии кода — из shared/*.js (фронт) и apps-script/*.gs (сервер) —
// в отдельные песочницы, как их выполнили бы браузер и Apps Script: без require,
// файлы просто выполняются друг за другом в общем глобальном пространстве.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function sandbox(files) {
  const ctx = vm.createContext({});
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  return ctx;
}

function copies() {
  const web = sandbox(['shared/status.js', 'shared/core.js']);
  // Core.gs идёт ПЕРВЫМ: в Apps Script порядок файлов не гарантирован.
  const gas = sandbox(['apps-script/Core.gs', 'apps-script/Status.gs']);
  return [
    { name: 'shared/*.js', Status: web.PlannerStatus, Core: web.PlannerCore },
    { name: 'apps-script/*.gs', Status: gas.PlannerStatus, Core: gas.PlannerCore }
  ];
}

// Объекты из песочницы имеют чужие прототипы — для deepStrictEqual
// приводим к обычным объектам этой песочницы.
const plain = (x) => JSON.parse(JSON.stringify(x));

module.exports = { copies, plain, ROOT };
