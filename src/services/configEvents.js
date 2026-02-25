/**
 * 配置同步事件总线
 * 用 EventEmitter 统一触发 syncAllNodesConfig，替代分散的直接调用
 */
const EventEmitter = require('events');

const configEvents = new EventEmitter();

// 触发全节点配置同步
function emitSyncAll() {
  configEvents.emit('sync-all');
}

// 触发单节点配置同步
function emitSyncNode(node) {
  configEvents.emit('sync-node', node);
}

module.exports = { configEvents, emitSyncAll, emitSyncNode };
