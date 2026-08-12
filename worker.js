'use strict';
const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');
const {
  Mnemonic, HDNodeWallet, SigningKey,
  computeHmac, keccak256, dataSlice, getAddress, concat, toBeHex,
} = require('ethers');

const { repeatLen, indexesPerMnemonic, reportEvery, basePath } = workerData;

// Bậc của đường cong secp256k1
const CURVE_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * Tạo mnemonic mới + derive sẵn node cha tại basePath (m/44'/60'/0'/0).
 * Đây là bước ĐẮT NHẤT (PBKDF2 2048 vòng HMAC-SHA512) nên chỉ làm
 * 1 lần cho mỗi `indexesPerMnemonic` địa chỉ con.
 */
function newParent() {
  const mnemonic = Mnemonic.fromEntropy(crypto.randomBytes(16)); // 12 từ, 128-bit
  const node = HDNodeWallet.fromMnemonic(mnemonic, basePath);
  return {
    phrase: mnemonic.phrase,
    privBig: BigInt(node.privateKey),
    chainCode: node.chainCode,
    pubCompressed: node.publicKey,
  };
}

/**
 * CKDpriv (BIP32, non-hardened) viết tay — tương đương node.deriveChild(i)
 * nhưng bỏ qua việc dựng object HDNodeWallet đầy đủ => nhanh hơn ~2.3x.
 * Tính đúng đắn được kiểm chứng bằng selfTest() bên dưới trước khi chạy.
 */
function deriveChildFast(p, index) {
  const I = computeHmac(
    'sha512',
    p.chainCode,
    concat([p.pubCompressed, toBeHex(index, 4)])
  );
  const childKey = (BigInt(dataSlice(I, 0, 32)) + p.privBig) % CURVE_N;
  const privHex = toBeHex(childKey, 32);
  const pubUncompressed = SigningKey.computePublicKey(privHex, false);
  // address = 20 byte cuối của keccak256(pubkey không nén, bỏ prefix 0x04)
  const address = getAddress(
    dataSlice(keccak256('0x' + pubUncompressed.substring(4)), 12)
  );
  return { address, privateKey: privHex };
}

/**
 * Đối chiếu bản viết tay với ethers trên vài index.
 * Nếu lệch => dừng ngay, KHÔNG chạy tiếp (tránh sinh ra key sai âm thầm).
 */
function selfTest() {
  const mnemonic = Mnemonic.fromEntropy(crypto.randomBytes(16));
  const node = HDNodeWallet.fromMnemonic(mnemonic, basePath);
  const p = {
    privBig: BigInt(node.privateKey),
    chainCode: node.chainCode,
    pubCompressed: node.publicKey,
  };
  for (const i of [0, 1, 7, 1234, 99999]) {
    const mine = deriveChildFast(p, i);
    const ref = node.deriveChild(i);
    if (mine.address !== ref.address || mine.privateKey !== ref.privateKey) {
      throw new Error(`Self-test CKDpriv THẤT BẠI tại index ${i}`);
    }
  }
}

/**
 * Kiểm tra N ký tự cuối của địa chỉ có giống hệt nhau không.
 * So sánh không phân biệt hoa/thường (địa chỉ có checksum EIP-55).
 * Thoát sớm ngay ký tự đầu tiên lệch => 15/16 trường hợp chỉ tốn 1 phép so.
 */
function hasRepeatingTail(address, n) {
  const len = address.length; // 42 = "0x" + 40 hex
  const last = address.charCodeAt(len - 1) | 0x20; // ép về chữ thường
  for (let i = 2; i <= n; i++) {
    if ((address.charCodeAt(len - i) | 0x20) !== last) return false;
  }
  return true;
}

// ---------------------------------------------------------------- vòng lặp
selfTest();
parentPort.postMessage({ type: 'ready' });

let parent = newParent();
let index = 0;
let sinceReport = 0;

while (true) {
  const child = deriveChildFast(parent, index);

  if (hasRepeatingTail(child.address, repeatLen)) {
    parentPort.postMessage({
      type: 'found',
      data: {
        address: child.address,
        privateKey: child.privateKey,
        mnemonic: parent.phrase,
        path: `${basePath}/${index}`,
        foundAt: new Date().toISOString(),
      },
    });
  }

  index++;
  if (index >= indexesPerMnemonic) {
    parent = newParent();
    index = 0;
  }

  if (++sinceReport >= reportEvery) {
    parentPort.postMessage({ type: 'count', count: sinceReport });
    sinceReport = 0;
  }
}
