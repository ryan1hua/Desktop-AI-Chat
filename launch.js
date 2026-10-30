// ============================================================
//  launch.js —— 启动器（软件的入口，npm start 实际跑的就是它）
// ------------------------------------------------------------
//  为什么需要它？
//  有些终端 / IDE 环境会偷偷设置一个环境变量
//      ELECTRON_RUN_AS_NODE=1
//  它会让 Electron 变成「纯 Node 模式」，结果就是窗口打不开、
//  主进程报错。所以这里在启动前先把该变量删掉，再启动 Electron。
//
//  在正常环境里它什么都不影响，可以放心，不用深究。
// ============================================================

// spawn 用来「启动另一个程序」
const { spawn } = require('child_process');

// 关键一步：删掉那个会捣乱的环境变量
delete process.env.ELECTRON_RUN_AS_NODE;

// 在系统 Node 里，require('electron') 拿到的不是功能，而是
// electron.exe 的「文件路径」——这正好是我们启动它需要的。
const electronPath = require('electron');

// 启动 Electron，参数 "." 表示「把当前文件夹当作这个应用」
const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',     // Electron 的打印信息原样接到我们终端上
  env: process.env,     // 把（已经清理过的）环境变量传给它
  windowsHide: false    // 允许显示窗口
});

// Electron 退出后，我们也跟着退出，并把它的退出码原样返回
child.on('close', (code) => process.exit(code ?? 0));

// 万一连 Electron 都启动不起来，打印个明白点的错误
child.on('error', (err) => {
  console.error('启动 Electron 失败：', err);
  process.exit(1);
});
