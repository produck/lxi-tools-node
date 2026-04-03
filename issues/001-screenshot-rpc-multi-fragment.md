# Issue #001: Screenshot 截图失败 — RPC 多分片记录标记未正确处理

- **日期**: 2026-04-03
- **设备**: Rigol DS1000Z 系列 (192.168.213.73)
- **模块**: `src/vxi11.mjs` — `tcpSendAndReceive()`
- **状态**: ✅ 已修复

---

## 1. 现象描述

调用 `Screenshot.screenshot()` 对真实设备进行截图时抛出异常：

```
Error: Expected RPC reply, got messageType=0
    at parseRpcReply (src/rpc.mjs:141:11)
    at Vxi11Session._rpcCall (src/vxi11.mjs:209:25)
```

截图场景下设备返回约 1.84MB 的 PNG 图像数据，远大于普通 SCPI 查询（通常几十到几百字节）。

---

## 2. 错误分析过程

### 2.1 第一阶段 — 错误发生在 `disconnect` (close)

初始报错堆栈：

```
at Vxi11Session.close (src/vxi11.mjs:247:7)
at async disconnect (src/lxi.mjs:188:3)
at async Object.capture (src/screenshot.mjs:71:9)
```

这说明截图数据的 `receive` 虽然返回了，但 TCP 流中残留了未消费的字节。当随后的 `destroy_link` RPC 调用发出后，`tcpSendAndReceive` 读到的并非 `destroy_link` 的响应，而是上一次 `device_read` 遗留的数据——其第 4~7 字节不是 `messageType=1 (REPLY)`，而是 `0 (CALL)` 或其他值，从而抛出错误。

### 2.2 第二阶段 — 修复 overflow 后错误转移到 `receive`

加入 `socket._rxOverflow` 机制后，`close` 阶段不再报错，但错误转到了截图数据读取本身：

```
at Vxi11Session.receive (src/vxi11.mjs:250:42)
at async Object.capture (src/screenshot.mjs:67:26)
```

这表明**不是简单的溢出问题，而是 RPC 多分片记录标记（multi-fragment record marking）未被支持**。

---

## 3. 根因 — RPC Record Marking 协议

### 3.1 协议规范 (RFC 5531 §11)

ONC-RPC 在 TCP 上使用 **Record Marking (RM)** 来划分消息边界。一条完整的 RPC 记录由一个或多个**分片 (fragment)** 组成：

```
record = fragment_1 | fragment_2 | ... | fragment_N

每个 fragment 格式:
+----+----+----+----+---...---+
| header (4 bytes)  |  data   |
+----+----+----+----+---...---+

header 的 32 位:
  bit 31 (最高位): last-fragment 标志 (1 = 最后一个分片)
  bit 0~30:       本分片数据长度 (字节)
```

对于小响应（如 `*IDN?`），设备只发一个分片（header 最高位 = 1），单分片即完整记录。
但对于大数据传输（如 1.84MB 截图），设备会将数据分成多个分片发送。

### 3.2 旧代码的问题

旧的 `tcpSendAndReceive` 实现：

```javascript
// ❌ 旧代码 — 只解析第一个分片的 header
function tcpSendAndReceive(socket, data, timeout) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let totalLength = 0;
		let expectedLength = -1;

		// ...

		function onData(chunk) {
			chunks.push(chunk);
			totalLength += chunk.length;

			// 只读第一个 4 字节 header，算出 expectedLength
			if (expectedLength < 0 && totalLength >= 4) {
				const combined = Buffer.concat(chunks);
				const header = combined.readUInt32BE(0);
				expectedLength = (header & 0x7fffffff) + 4;
				//              ↑ 忽略了 last-fragment 标志位！
			}

			// 一旦收满第一个分片就认为结束
			if (expectedLength > 0 && totalLength >= expectedLength) {
				cleanup();
				const combined = Buffer.concat(chunks);
				const header = combined.readUInt32BE(0);
				const fragmentLength = header & 0x7fffffff;
				resolve(combined.subarray(4, 4 + fragmentLength));
				// ❌ 后续分片的数据被直接丢弃
			}
		}
	});
}
```

**两个致命缺陷：**

1. **不检查 last-fragment 标志位** — 永远在第一个分片结束时就 resolve，后续分片的数据残留在 TCP 缓冲区
2. **无溢出处理** — TCP 是流式协议，一次 `data` 事件可能包含当前 RPC 响应的尾部 + 下一个响应的头部（甚至更多），多余字节被丢弃

数据流示意（截图场景，假设 3 个分片）：

```
TCP 流:
[frag1 header][frag1 data][frag2 header][frag2 data][frag3 header+last][frag3 data]

旧代码只读:
[frag1 header][frag1 data] ← resolve
                           ↑ 后面的全部被丢弃

后续 destroy_link 的 RPC 请求发出后:
tcpSendAndReceive 读到的是 [frag2 header][frag2 data]...（残留数据）
→ parseRpcReply 解析时 messageType ≠ 1 → 抛出 "Expected RPC reply, got messageType=0"
```

---

## 4. 修复方案

### 4.1 改动文件

- `packages/lxi-tools-node/src/vxi11.mjs`

### 4.2 修复 1 — 完整支持 RPC 多分片记录标记

重写 `tcpSendAndReceive`，正确按 RFC 5531 解析所有分片：

```javascript
// ✅ 新代码 — 支持多分片 + 溢出处理
function tcpSendAndReceive(socket, data, timeout) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let totalLength = 0;

		// 拼接上一次调用残留的溢出数据
		if (socket._rxOverflow && socket._rxOverflow.length > 0) {
			chunks.push(socket._rxOverflow);
			totalLength = socket._rxOverflow.length;
			socket._rxOverflow = null;
		}

		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("RPC receive timed out"));
		}, timeout);

		function tryResolve() {
			const combined = totalLength === 0 ? null : Buffer.concat(chunks);
			if (!combined) return false;

			const payloadParts = [];
			let offset = 0;

			// 逐个解析分片
			while (offset + 4 <= combined.length) {
				const header = combined.readUInt32BE(offset);
				const isLast = !!(header & 0x80000000); // 检查最高位
				const fragLen = header & 0x7fffffff;

				// 当前分片数据尚未完整到达，等待更多 TCP 数据
				if (offset + 4 + fragLen > combined.length) break;

				payloadParts.push(combined.subarray(offset + 4, offset + 4 + fragLen));
				offset += 4 + fragLen;

				// 遇到 last-fragment 标志 → 记录完整
				if (isLast) {
					cleanup();
					// 保存溢出字节给下一次 RPC 调用
					if (offset < combined.length) {
						socket._rxOverflow = combined.subarray(offset);
					}
					resolve(Buffer.concat(payloadParts));
					return true;
				}
			}
			return false;
		}

		// 溢出数据可能已包含完整记录
		if (totalLength > 0 && tryResolve()) return;

		function onData(chunk) {
			chunks.push(chunk);
			totalLength += chunk.length;
			tryResolve();
		}

		// ...事件监听与 cleanup 同前
	});
}
```

**关键改进点：**

| 对比项             | 旧代码                 | 新代码                                     |
| ------------------ | ---------------------- | ------------------------------------------ |
| 分片处理           | 只读第一个分片 header  | 循环解析所有分片                           |
| last-fragment 标志 | 忽略                   | 正确检查 `header & 0x80000000`             |
| 数据拼接           | 只返回第一个分片的数据 | `Buffer.concat(payloadParts)` 拼接所有分片 |
| 溢出处理           | 丢弃多余字节           | 保存到 `socket._rxOverflow` 供下次使用     |
| 跨调用一致性       | 残留数据污染后续 RPC   | 干净的帧边界分离                           |

### 4.3 修复 2 — `close()` 容错处理

`destroy_link` 是 VXI-11 断连前的礼貌通知，即使失败也不应阻止上层操作获取已收到的截图数据：

```javascript
// ❌ 旧代码 — destroy_link 失败直接抛出
async close() {
  try {
    const payloadBuffer = buildDestroyLink(this._linkId);
    await this._rpcCall(DESTROY_LINK, payloadBuffer);
  } finally {
    this._socket.destroy();
  }
}

// ✅ 新代码 — 捕获并忽略 destroy_link 错误
async close() {
  try {
    const payloadBuffer = buildDestroyLink(this._linkId);
    await this._rpcCall(DESTROY_LINK, payloadBuffer);
  } catch {
    // Ignore destroy_link errors — socket will be destroyed anyway
  } finally {
    this._socket.destroy();
  }
}
```

---

## 5. 附带修复 — import 路径不匹配

排查过程中还发现 6 处 import 路径错误，所有源文件都是 `.mjs` 后缀，但部分 import 写了 `.js`：

| 文件                 | 错误路径     | 修正后        |
| -------------------- | ------------ | ------------- |
| `src/vxi11.mjs`      | `'./rpc.js'` | `'./rpc.mjs'` |
| `src/discover.mjs`   | `'./rpc.js'` | `'./rpc.mjs'` |
| `src/discover.mjs`   | `'./lxi.js'` | `'./lxi.mjs'` |
| `src/scpi.mjs`       | `'./lxi.js'` | `'./lxi.mjs'` |
| `src/benchmark.mjs`  | `'./lxi.js'` | `'./lxi.mjs'` |
| `src/screenshot.mjs` | `'./lxi.js'` | `'./lxi.mjs'` |

> 注: Node.js ESM 模式下 import 路径必须包含完整文件扩展名，`.mjs` 和 `.js` 不会自动互相解析。这些路径在运行时会直接报 `ERR_MODULE_NOT_FOUND`。

---

## 6. 验证结果

修复后重新运行截图测试：

```
--- Screenshot Debug ---
已注册插件 (24): ...

正在检测设备 192.168.213.73 ...
检测到插件: rigol-1000z

正在截图 ...
截图完成 — 插件: rigol-1000z, 格式: png, 大小: 1843255 bytes
已保存: test/output/screenshot_1775199196743.png
```

截图 1.84MB PNG 文件成功保存，`close()` 正常完成无异常。

---

## 7. 额外发现 — 插件自动检测

设备自动检测结果为 `rigol-1000z`（DS1000Z 系列），而非用户最初手动指定的 `rigol-2000`。两者的 SCPI 截图命令不同：

| 插件          | SCPI 命令                | 返回格式 |
| ------------- | ------------------------ | -------- |
| `rigol-1000z` | `display:data? on,0,png` | PNG      |
| `rigol-2000`  | `:display:data?`         | BMP      |

使用错误的插件可能导致设备返回错误或图像格式不正确。建议优先使用自动检测（`plugin: undefined`）。
