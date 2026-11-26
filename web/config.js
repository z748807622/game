// config.js — 前端运行时配置（部署时改这个文件，不需要重编 Go 二进制）。
//
// wsUrl 留空 = 连接当前页面同源的 /ws。
// 前后端不同域时填后端地址，例如：
//   window.RELAY_CONFIG = { wsUrl: 'wss://api.example.com/ws' };
// 也可以写相对路径（如 '/relay/ws'）或 http(s) 地址，relay.js 会自动归一化。
window.RELAY_CONFIG = {
  wsUrl: ''
};
