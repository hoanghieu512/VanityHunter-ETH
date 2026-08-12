# VanityHunter-ETH

Công cụ **Node.js đa luồng** đào ví Ethereum "đẹp" — tìm địa chỉ có **N ký tự cuối giống hệt nhau** (ví dụ `0x...8888888`). Sinh mnemonic ngẫu nhiên, derive địa chỉ theo chuẩn **BIP32/BIP44**, và mọi ví tìm được đều được **verify độc lập bằng `ethers`** trước khi ghi ra file.

- **Đa luồng thật** — dùng `worker_threads`, mặc định chạy đủ số core máy; mỗi luồng đào độc lập, luồng crash được tự khởi động lại.
- **CKDpriv viết tay** — cài đặt lại phép derive child key (BIP32 non-hardened) để bỏ qua việc dựng object `HDNodeWallet` đầy đủ, **nhanh hơn ~2.3x** so với `node.deriveChild(i)`.
- **Self-test trước khi đào** — mỗi worker đối chiếu bản viết tay với `ethers` trên 5 index trước khi vào vòng lặp; lệch một bit là dừng ngay, không bao giờ sinh key sai âm thầm.

Thêm: thống kê realtime (tốc độ, ETA, % chu kỳ), ghi **append-only** để kill giữa chừng không hỏng dữ liệu, script `verify.js` kiểm tra lại toàn bộ file kết quả.

---

## Overview

**Node.js thuần** (CommonJS), phụ thuộc duy nhất là **`ethers` v6**. Không có UI, không có server, không có network call — toàn bộ chạy offline trên máy bạn.

Tiến trình **main** (`main.js`) spawn N worker, nhận message, verify và ghi file. Mỗi **worker** (`worker.js`) chạy vòng lặp vô hạn: sinh mnemonic → derive địa chỉ con → kiểm tra đuôi → báo cáo. Giao tiếp qua `postMessage` với ba loại message: `ready` (qua self-test), `count` (tiến độ), `found` (tìm được ví).

Kết quả lưu vào **`wallets.jsonl`** — mỗi dòng một JSON object gồm `address`, `privateKey`, `mnemonic`, `path`, `foundAt`. File này nằm trong `.gitignore`.

---

## Features

- **Tìm đuôi lặp** — quét địa chỉ có `REPEAT_LEN` ký tự cuối giống nhau. So sánh **không phân biệt hoa/thường** (địa chỉ EIP-55 có checksum), thoát sớm ngay ký tự đầu tiên lệch nên 15/16 trường hợp chỉ tốn đúng 1 phép so sánh.
- **Hai chế độ derive** — `INDEXES_PER_MNEMONIC=1`: mnemonic mới mỗi vòng, path chuẩn `m/44'/60'/0'/0/0`, **import seed phrase vào MetaMask thấy ngay** nhưng chậm ~30x (mỗi vòng tốn một lần PBKDF2 2048 vòng HMAC-SHA512). `INDEXES_PER_MNEMONIC=5000`: nhanh, nhưng ví nằm ở index cao ⇒ **phải import bằng private key**.
- **Verify hai lớp** — worker báo `found` → main dựng lại ví từ `mnemonic + path` bằng `ethers` và so cả `address` lẫn `privateKey`; sai thì **từ chối, không ghi file** và đếm vào `rejected`. Chỉ ví đã verify mới được `appendFileSync`.
- **Tự phục hồi luồng** — worker `error` → log lỗi và respawn sau 1s (trừ khi đang shutdown), nên một luồng chết không làm giảm vĩnh viễn công suất đào.
- **Thống kê realtime** — cập nhật mỗi 5s trên một dòng: tổng địa chỉ đã thử, tốc độ addr/s, số ví tìm được (kèm số bị từ chối), **ETA chu kỳ** ước tính từ độ khó `16^(REPEAT_LEN-1)`, thời gian đã chạy và % chu kỳ. Worker gộp báo cáo mỗi 2000 địa chỉ để giảm chi phí IPC.
- **Ghi append-only** — mỗi ví ghi ngay một dòng khi tìm được, không giữ buffer trong RAM; `Ctrl+C` hay kill process giữa chừng đều không làm hỏng dữ liệu đã lưu.
- **Shutdown sạch** — bắt `SIGINT` / `SIGTERM`, in tổng kết (đã thử / tốc độ trung bình / số ví) rồi `terminate()` toàn bộ worker trước khi thoát.
- **Script verify độc lập** — `verify.js` đọc lại file kết quả và kiểm tra **ba chiều** cho từng dòng: address từ mnemonic, privateKey từ mnemonic, và address dựng lại từ privateKey. Exit code khác 0 nếu có dòng sai.

---

## Tech stack

| Lớp | Công nghệ |
|-----|-----------|
| Runtime | Node.js 20+ (CommonJS) |
| Song song | `worker_threads` (built-in) |
| Crypto | `ethers` v6 — `Mnemonic`, `HDNodeWallet`, `SigningKey`, `computeHmac`, `keccak256` |
| Entropy | `crypto.randomBytes(16)` — mnemonic 12 từ, 128-bit |
| Đường cong | secp256k1 (bậc `N` hard-code trong `worker.js`) |
| Output | JSONL append-only (`wallets.jsonl`) |

---

## Cách chạy (How to run)

### Yêu cầu

- [Node.js](https://nodejs.org/) 20+ (khuyến nghị LTS)
- npm (đi kèm Node)

### Cài đặt

```bash
cd VanityHunter-ETH
npm install
```

### Chạy đào

```bash
node main.js
```

Dừng: **Ctrl+C** — app in tổng kết rồi thoát sạch.

### Kiểm tra lại kết quả

```bash
node verify.js
```

Hoặc chỉ định file khác: `node verify.js path/to/wallets.jsonl`.

---

## Cấu hình (biến môi trường)

| Biến | Mặc định | Mô tả |
|------|----------|--------|
| `REPEAT_LEN` | `8` | Số ký tự cuối giống nhau cần tìm |
| `INDEXES_PER_MNEMONIC` | `1` | Số địa chỉ con quét trên mỗi mnemonic |
| `THREADS` | số core máy | Số worker chạy song song |
| `OUT` | `wallets.jsonl` | File lưu kết quả |

Ví dụ — tìm đuôi 7 ký tự, 8 luồng, chế độ nhanh:

```bash
REPEAT_LEN=7 THREADS=8 INDEXES_PER_MNEMONIC=5000 node main.js
```

---

## Độ khó

Trung bình cần thử `16^(REPEAT_LEN-1)` địa chỉ để ra **một** ví:

| `REPEAT_LEN` | Địa chỉ cần thử (trung bình) | Ví dụ đuôi |
|-------------|------------------------------|------------|
| 6 | ~1,05 triệu | `0x...aaaaaa` |
| 7 | ~16,8 triệu | `0x...aaaaaaa` |
| 8 | ~268 triệu | `0x...aaaaaaaa` |
| 9 | ~4,3 tỷ | `0x...aaaaaaaaa` |

Mỗi bậc `REPEAT_LEN` tăng thêm 1 thì độ khó **nhân 16**. Con số ETA trên màn hình là kỳ vọng thống kê, không phải deadline — bạn có thể ra ví ở phút thứ nhất hoặc sau nhiều chu kỳ.

---

## Import ví vào MetaMask

### Chế độ `INDEXES_PER_MNEMONIC=1` (path chuẩn)
1. MetaMask → **Import wallet** / **Khôi phục bằng cụm từ khôi phục**
2. Dán `mnemonic` từ dòng JSON
3. Ví hiện ngay ở tài khoản đầu tiên (`m/44'/60'/0'/0/0`)

### Chế độ `INDEXES_PER_MNEMONIC` > 1 (index cao)
1. MetaMask → **Import account** → **Private Key**
2. Dán `privateKey` từ dòng JSON

---

## Security note

- **`wallets.jsonl` chứa private key và mnemonic ở dạng plaintext.** File đã nằm trong `.gitignore` — **đừng bao giờ commit hoặc chia sẻ nó**.
- Toàn bộ quá trình chạy **offline**: không có network call, không gửi key đi đâu. Bạn có thể kiểm chứng bằng cách đọc `main.js` / `worker.js` (tổng ~250 dòng).
- Entropy lấy từ `crypto.randomBytes` (CSPRNG của OS) — không dùng `Math.random`.
- Ví đào ra là ví **thật, hợp lệ**, không có backdoor; nhưng chỉ nên dùng cho mục đích trang trí/nhận diện, không phải để tăng bảo mật.
- Nếu chạy trên máy dùng chung hoặc VPS, cân nhắc xoá `wallets.jsonl` sau khi đã chuyển key sang nơi lưu trữ an toàn.

---

## Troubleshooting

| Lỗi | Giải pháp |
|-----|-----------|
| `Cannot find module 'ethers'` | Chạy `npm install` trong thư mục dự án |
| `Self-test CKDpriv THẤT BẠI tại index N` | Phiên bản `ethers` không tương thích — cài lại `ethers@^6.17.0`; **không** bỏ qua lỗi này, nó ngăn sinh key sai |
| `⛔ Ví bị TỪ CHỐI (verify thất bại)` | Bộ nhớ/CPU lỗi hoặc build `ethers` hỏng — ví đó **không** được ghi file, nên dữ liệu vẫn an toàn; kiểm tra lại máy nếu số này tăng liên tục |
| Tốc độ rất chậm (vài trăm addr/s) | Bình thường khi `INDEXES_PER_MNEMONIC=1` (mỗi vòng một lần PBKDF2). Tăng lên `5000` để nhanh ~30x, đổi lại phải import bằng private key |
| Chạy mãi không ra ví | Xem cột `chu kỳ ~` — với `REPEAT_LEN=8` cần trung bình 268 triệu địa chỉ; giảm `REPEAT_LEN` xuống 6–7 để ra kết quả nhanh hơn |
| Máy nóng / lag khi làm việc khác | Giảm `THREADS` (ví dụ `THREADS=4`) — mặc định dùng hết số core |
| `node verify.js` báo `Không tìm thấy wallets.jsonl` | Chưa đào được ví nào, hoặc đã đổi `OUT` — truyền đúng đường dẫn: `node verify.js path/to/file.jsonl` |
| `❌ dòng N: JSON hỏng` | Dòng bị ghi dở do đĩa đầy hoặc kill đúng lúc ghi — xoá riêng dòng đó, các dòng khác vẫn hợp lệ |
