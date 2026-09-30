const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });
const queue = new Queue('deal-room-jobs', { connection });
module.exports = { connection, queue };
