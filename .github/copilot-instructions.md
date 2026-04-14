# lxi-tools-node 工程指南

本文件为 GitHub Copilot Agent 提供工程上下文，帮助快速理解和协助开发。

## 工程概述

这是一个 **monorepo** 工作空间，包含两个 npm 包：

| 包名 | 路径 | 描述 |
|------|------|------|
| `@produck/lxi-tools-node` | `packages/lxi-tools-node` | LXI/VXI-11 仪器通信库 |
| `@produck/vxi-mock-device` | `packages/vxi-mock-device` | VXI-11 模拟设备（测试用） |

## 技术栈

- **运行时**: Node.js (ESM modules, `.mjs` 扩展名)
- **包管理**: npm workspaces + lerna
- **测试**: Node.js 内置 test runner (`node --test`)
- **覆盖率**: c8
- **代码规范**: ESLint

## 常用命令

```bash
# 安装依赖
npm install

# 运行所有测试
npm test

# 运行覆盖率测试
npm run coverage

# 代码检查
npm run lint
```

## 测试规范

### 重要规则

1. **单入口模式是铁律**: 永远通过 `node --test test/index.mjs` 运行测试，绝不直接运行子文件
2. **局部调试**: 在目标 `describe/it` 上加 `{ only: true }`，然后 `node --test --test-only test/index.mjs`，调试完务必移除 only 标记
3. `--test-name-pattern` 不能匹配 nested `describe()` 内的测试

### 测试结构

```
packages/
├── lxi-tools-node/test/
│   ├── index.mjs          # 测试入口，导入所有 spec 文件
│   └── *.spec.mjs         # 各模块测试
└── vxi-mock-device/test/
    ├── index.mjs          # 测试入口
    └── MockDevice.spec.mjs
```

## 环境注意事项 (Windows)

- 终端是 Git Bash (非完全 POSIX 兼容)
- **避免使用 Git Bash unix tools** (grep, sed, awk, find, xargs, tail, head 等) 做数据处理
- **使用 `node -e "..."` 或临时 `.mjs` 脚本**代替 shell 管道
- 完整测试套件约需 100-110 秒，child_process timeout 建议设为 300000 (5分钟)

---

# 包详情

## @produck/lxi-tools-node

### 模块结构

| 文件 | 描述 |
|------|------|
| `src/index.mjs` | 主入口，re-export 所有模块 |
| `src/lxi.mjs` | 高层 API (connect/send/receive/disconnect) |
| `src/vxi11.mjs` | VXI-11 协议实现 |
| `src/rpc.mjs` | ONC-RPC/XDR 编解码 |
| `src/scpi.mjs` | SCPI 命令封装 |
| `src/discover.mjs` | 设备发现 (VXI-11 broadcast / mDNS) |
| `src/screenshot.mjs` | 仪器截图功能 |
| `src/benchmark.mjs` | 通信性能测试 |

### 协议支持

- **VXI-11**: 基于 ONC-RPC 的仪器通信协议
- **RAW/SCPI**: 基于 TCP 的行协议 (默认端口 5025)

---

## @produck/vxi-mock-device

用于测试的 VXI-11 模拟仪器，无需真实硬件。

### 核心组件

#### XdrWriter / XdrReader (`src/xdr.mjs`)

XDR 编解码工具类：

```javascript
// 写入
const writer = new XdrWriter();
writer.writeInt32(-42);
writer.writeUInt32(100);
writer.writeString('hello');
const buf = writer.toBuffer();

// 读取
const reader = new XdrReader(buf);
reader.readInt32();   // -42
reader.readUInt32();  // 100
reader.readString();  // 'hello'
```

#### MockDevice (`src/index.mjs`)

```javascript
import { MockDevice } from '@produck/vxi-mock-device';

const device = new MockDevice({
    identity: 'MANUFACTURER,MODEL,SERIAL,VERSION',
    maxReceiveSize: 0x100000,  // 1MB
    fragmentSize: 0            // 0 = 单分片
});

// 注册 SCPI 命令处理器
device.handle('*IDN?', () => device.identity);
device.handle('MEAS:VOLT?', () => '3.14159');

// 启动服务 (端口 0 = 系统分配)
await device.start(0, 0, 0);

console.log('Portmapper:', device.portmapperPort);
console.log('VXI-11:', device.vxi11Port);
console.log('RAW/SCPI:', device.rawPort);

// 停止服务
await device.stop();
```

### 协议常量

| 常量 | 值 | 描述 |
|------|-----|------|
| PORTMAPPER_PROGRAM | 100000 | 端口映射器程序号 |
| VXI11_CORE_PROGRAM | 0x0607af | VXI-11 核心程序号 |
| CREATE_LINK | 10 | 创建链接过程 |
| DEVICE_WRITE | 11 | 设备写过程 |
| DEVICE_READ | 12 | 设备读过程 |
| DESTROY_LINK | 23 | 销毁链接过程 |

### 内部架构

- `wrapRecord(buffer)` - 单分片 RPC 记录包装
- `wrapRecordMultiFragment(buffer, fragmentSize)` - 多分片 RPC 记录包装
- `buildRpcReply(xid, payload)` - 构建 RPC 回复
- `parseRpcCall(buffer)` - 解析 RPC 调用
- `ConnectionHandler` 类 - 处理单个 TCP 连接的 RPC 消息

### 测试覆盖率 (2026-04-14)

| 指标 | 覆盖率 |
|------|--------|
| Statements | 100% |
| Branches | 98.43% |
| Functions | 100% |
| Lines | 100% |

---

## 开发指南

### 添加新的 SCPI 命令

```javascript
// 在测试中注册自定义处理器
device.handle('MY:CMD?', (cmd) => {
    return 'response data';
});

// 异步处理器
device.handle('SLOW:CMD?', async (cmd) => {
    await someAsyncOperation();
    return 'result';
});

// 返回 null 表示无响应（用于设置命令）
device.handle('*RST', () => null);
```

### 调试技巧

1. **查看 RPC 通信**: 在 ConnectionHandler 的 `_process` 方法中添加日志
2. **模拟多分片响应**: 使用 `fragmentSize` 选项
3. **测试错误处理**: 在处理器中 throw 错误，服务器会静默吞掉以避免崩溃
