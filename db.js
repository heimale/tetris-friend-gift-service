const { Sequelize, DataTypes } = require("sequelize");

// 从环境变量中读取数据库配置
const { MYSQL_USERNAME, MYSQL_PASSWORD, MYSQL_ADDRESS = "" } = process.env;

const [host, port] = MYSQL_ADDRESS.split(":");

const sequelize = new Sequelize("nodejs_demo", MYSQL_USERNAME, MYSQL_PASSWORD, {
  host,
  port,
  dialect: "mysql" /* one of 'mysql' | 'mariadb' | 'postgres' | 'mssql' */,
});

// 定义数据模型
const Counter = sequelize.define("Counter", {
  count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
});

// 微信礼包发货订单。OrderId 作为主键，确保平台重试不会重复发放。
const GiftOrder = sequelize.define("GiftOrder", {
  orderId: {
    type: DataTypes.STRING(128),
    primaryKey: true,
  },
  openId: {
    type: DataTypes.STRING(64),
    allowNull: false,
  },
  giftTypeId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  giftId: {
    type: DataTypes.STRING(128),
    allowNull: false,
    defaultValue: "",
  },
  goodsJson: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: "[]",
  },
  treasureChestCount: {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: false,
    defaultValue: 0,
  },
  isPreview: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  sendTime: {
    type: DataTypes.BIGINT,
    allowNull: false,
    defaultValue: 0,
  },
}, {
  indexes: [
    { fields: ["openId"] },
  ],
});

// 每个玩家累计获赠数量。客户端只比较累计值，断线或重试都不会重复领取。
const GiftBalance = sequelize.define("GiftBalance", {
  openId: {
    type: DataTypes.STRING(64),
    primaryKey: true,
  },
  treasureChestGranted: {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: false,
    defaultValue: 0,
  },
});

// 数据库初始化方法
async function init() {
  await Counter.sync({ alter: true });
  await GiftOrder.sync();
  await GiftBalance.sync();
}

// 导出初始化方法和模型
module.exports = {
  init,
  sequelize,
  Counter,
  GiftOrder,
  GiftBalance,
};
