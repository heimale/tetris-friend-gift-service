const crypto = require("crypto");
const { GiftOrder, GiftBalance, sequelize } = require("./db");

const FRIEND_GIFT_TYPE_ID = 18;
const TREASURE_CHEST_GOOD_ID = "treasureChest";
const MAX_ORDER_REWARD_COUNT = 100;

function asText(value) {
  return value === undefined || value === null ? "" : String(value);
}

function sha1Signature(parts) {
  return crypto
    .createHash("sha1")
    .update(parts.map(asText).sort().join(""), "utf8")
    .digest("hex");
}

function signaturesEqual(actual, expected) {
  const left = Buffer.from(asText(actual), "utf8");
  const right = Buffer.from(asText(expected), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function pkcs7Pad(buffer) {
  const blockSize = 32;
  const padSize = blockSize - (buffer.length % blockSize);
  return Buffer.concat([buffer, Buffer.alloc(padSize, padSize)]);
}

function pkcs7Unpad(buffer) {
  if (!buffer.length) throw new Error("empty decrypted message");
  const padSize = buffer[buffer.length - 1];
  if (padSize < 1 || padSize > 32 || padSize > buffer.length) {
    throw new Error("invalid PKCS#7 padding");
  }
  for (let i = buffer.length - padSize; i < buffer.length; i += 1) {
    if (buffer[i] !== padSize) throw new Error("invalid PKCS#7 padding");
  }
  return buffer.subarray(0, buffer.length - padSize);
}

class WechatMessageCrypto {
  constructor({ token, encodingAesKey, appId }) {
    this.token = asText(token);
    this.appId = asText(appId);
    this.key = Buffer.from(`${asText(encodingAesKey)}=`, "base64");

    if (!this.token || !this.appId || this.key.length !== 32) {
      throw new Error("invalid WeChat message crypto configuration");
    }
  }

  verifyPlainSignature(signature, timestamp, nonce) {
    return signaturesEqual(
      signature,
      sha1Signature([this.token, timestamp, nonce])
    );
  }

  verifyMessageSignature(signature, timestamp, nonce, encrypted) {
    return signaturesEqual(
      signature,
      sha1Signature([this.token, timestamp, nonce, encrypted])
    );
  }

  decrypt(encrypted) {
    const decipher = crypto.createDecipheriv("aes-256-cbc", this.key, this.key.subarray(0, 16));
    decipher.setAutoPadding(false);
    const decrypted = pkcs7Unpad(Buffer.concat([
      decipher.update(Buffer.from(asText(encrypted), "base64")),
      decipher.final(),
    ]));

    if (decrypted.length < 20) throw new Error("invalid decrypted message");
    const messageLength = decrypted.readUInt32BE(16);
    const messageEnd = 20 + messageLength;
    if (messageEnd > decrypted.length) throw new Error("invalid decrypted message length");

    const message = decrypted.subarray(20, messageEnd).toString("utf8");
    const appId = decrypted.subarray(messageEnd).toString("utf8");
    if (appId !== this.appId) throw new Error("unexpected appid");
    return message;
  }

  encrypt(message) {
    const messageBuffer = Buffer.from(asText(message), "utf8");
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(messageBuffer.length, 0);
    const plain = pkcs7Pad(Buffer.concat([
      crypto.randomBytes(16),
      lengthBuffer,
      messageBuffer,
      Buffer.from(this.appId, "utf8"),
    ]));

    const cipher = crypto.createCipheriv("aes-256-cbc", this.key, this.key.subarray(0, 16));
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64");
  }

  buildEncryptedReply(message, timestamp, nonce) {
    const encrypted = this.encrypt(message);
    return {
      Encrypt: encrypted,
      MsgSignature: sha1Signature([this.token, timestamp, nonce, encrypted]),
      TimeStamp: Number(timestamp),
      Nonce: asText(nonce),
    };
  }
}

function getMessageCrypto() {
  return new WechatMessageCrypto({
    token: process.env.WECHAT_MESSAGE_TOKEN,
    encodingAesKey: process.env.WECHAT_ENCODING_AES_KEY,
    appId: process.env.WECHAT_APP_ID,
  });
}

function normalizeGoods(goodsList) {
  const list = Array.isArray(goodsList) ? goodsList : [];
  let treasureChestCount = 0;

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i] || {};
    const id = asText(item.Id).trim();
    const count = Math.floor(Number(item.Num));
    if (id !== TREASURE_CHEST_GOOD_ID || !Number.isSafeInteger(count) || count <= 0) {
      throw new Error("unsupported gift goods");
    }
    treasureChestCount += count;
  }

  if (treasureChestCount <= 0 || treasureChestCount > MAX_ORDER_REWARD_COUNT) {
    throw new Error("invalid gift goods count");
  }

  return treasureChestCount;
}

async function recordGiftDelivery(message) {
  if (!message || message.MsgType !== "event" || message.Event !== "minigame_deliver_goods") {
    return { handled: false };
  }

  const data = message.MiniGame || {};
  const orderId = asText(data.OrderId).trim();
  const openId = asText(data.ToUserOpenid).trim();
  const giftId = asText(data.GiftId).trim();
  const giftTypeId = Math.floor(Number(data.GiftTypeId) || 0);
  const sendTime = Math.max(0, Math.floor(Number(data.SendTime) || 0));
  const isPreview = Number(data.IsPreview) === 1;
  const goodsList = Array.isArray(data.GoodsList) ? data.GoodsList : [];

  if (!orderId || !openId) throw new Error("missing gift order identity");
  if (giftTypeId !== FRIEND_GIFT_TYPE_ID) {
    return { handled: false, ignored: true };
  }
  const treasureChestCount = normalizeGoods(goodsList);

  let created = false;
  try {
    await sequelize.transaction(async (transaction) => {
      const existing = await GiftOrder.findByPk(orderId, { transaction });
      if (existing) return;

      await GiftOrder.create({
        orderId,
        openId,
        giftTypeId,
        giftId,
        goodsJson: JSON.stringify(goodsList),
        treasureChestCount,
        isPreview,
        sendTime,
      }, { transaction });

      await GiftBalance.findOrCreate({
        where: { openId },
        defaults: { openId, treasureChestGranted: 0 },
        transaction,
      });
      await GiftBalance.increment(
        { treasureChestGranted: treasureChestCount },
        { where: { openId }, transaction }
      );
      created = true;
    });
  } catch (error) {
    if (error && error.name === "SequelizeUniqueConstraintError") {
      created = false;
    } else {
      throw error;
    }
  }

  return {
    handled: true,
    created,
    giftTypeId,
    isFriendGift: giftTypeId === FRIEND_GIFT_TYPE_ID,
  };
}

function getTrustedOpenId(req) {
  if (!asText(req.headers["x-wx-source"]).trim()) return "";
  return asText(req.headers["x-wx-openid"]).trim();
}

function registerGiftRoutes(app) {
  app.get("/wechat/message", (req, res) => {
    try {
      const messageCrypto = getMessageCrypto();
      const timestamp = asText(req.query.timestamp);
      const nonce = asText(req.query.nonce);
      const echo = asText(req.query.echostr);
      const messageSignature = asText(req.query.msg_signature);

      if (messageSignature) {
        if (!messageCrypto.verifyMessageSignature(messageSignature, timestamp, nonce, echo)) {
          return res.status(403).send("invalid signature");
        }
        return res.type("text/plain").send(messageCrypto.decrypt(echo));
      }

      if (!messageCrypto.verifyPlainSignature(req.query.signature, timestamp, nonce)) {
        return res.status(403).send("invalid signature");
      }
      return res.type("text/plain").send(echo);
    } catch (error) {
      console.error("[gift] message URL validation failed:", error.message);
      return res.status(503).send("message service unavailable");
    }
  });

  app.post("/wechat/message", async (req, res) => {
    let encryptedRequest = false;
    let messageCrypto = null;
    let timestamp = asText(req.query.timestamp);
    let nonce = asText(req.query.nonce);

    try {
      messageCrypto = getMessageCrypto();
      const encrypted = asText(req.body && (req.body.Encrypt || req.body.encrypt));
      let message = req.body;

      if (encrypted) {
        encryptedRequest = true;
        if (!messageCrypto.verifyMessageSignature(
          req.query.msg_signature,
          timestamp,
          nonce,
          encrypted
        )) {
          return res.status(403).send("invalid signature");
        }
        message = JSON.parse(messageCrypto.decrypt(encrypted));
      } else if (!messageCrypto.verifyPlainSignature(req.query.signature, timestamp, nonce)) {
        return res.status(403).send("invalid signature");
      }

      const result = await recordGiftDelivery(message);
      if (!result.handled) return res.type("text/plain").send("success");

      const replyText = JSON.stringify({ ErrCode: 0, ErrMsg: "Success" });
      if (!encryptedRequest) return res.json({ ErrCode: 0, ErrMsg: "Success" });

      timestamp = timestamp || String(Math.floor(Date.now() / 1000));
      nonce = nonce || crypto.randomBytes(8).toString("hex");
      return res.json(messageCrypto.buildEncryptedReply(replyText, timestamp, nonce));
    } catch (error) {
      console.error("[gift] delivery failed:", error.message);
      const failure = { ErrCode: 1, ErrMsg: "Delivery failed" };

      if (encryptedRequest && messageCrypto) {
        try {
          timestamp = timestamp || String(Math.floor(Date.now() / 1000));
          nonce = nonce || crypto.randomBytes(8).toString("hex");
          return res.json(
            messageCrypto.buildEncryptedReply(JSON.stringify(failure), timestamp, nonce)
          );
        } catch (replyError) {
          console.error("[gift] encrypted failure reply failed:", replyError.message);
        }
      }
      return res.status(500).json(failure);
    }
  });

  app.get("/api/gifts/balance", async (req, res) => {
    const openId = getTrustedOpenId(req);
    if (!openId) {
      return res.status(401).json({ code: 401, message: "missing trusted openid" });
    }

    const expectedAppId = asText(process.env.WECHAT_APP_ID).trim();
    const requestAppId = asText(req.headers["x-wx-appid"]).trim();
    if (!expectedAppId || requestAppId !== expectedAppId) {
      return res.status(403).json({ code: 403, message: "unexpected appid" });
    }

    try {
      const balance = await GiftBalance.findByPk(openId);
      res.set("Cache-Control", "no-store");
      return res.json({
        code: 0,
        data: {
          treasureChestGranted: Math.max(
            0,
            Math.floor(Number(balance && balance.treasureChestGranted) || 0)
          ),
        },
      });
    } catch (error) {
      console.error("[gift] balance query failed:", error.message);
      return res.status(500).json({ code: 500, message: "gift balance unavailable" });
    }
  });
}

module.exports = {
  FRIEND_GIFT_TYPE_ID,
  TREASURE_CHEST_GOOD_ID,
  WechatMessageCrypto,
  getTrustedOpenId,
  normalizeGoods,
  recordGiftDelivery,
  registerGiftRoutes,
  sha1Signature,
};
