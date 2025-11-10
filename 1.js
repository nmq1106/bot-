require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle,
  Collection,
  AttachmentBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  Events
} = require('discord.js');
const chalk = require('chalk');
const figlet = require('figlet');
const gradient = require('gradient-string');
const boxen = require('boxen');
const moment = require('moment');
const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const { 
  createAudioPlayer, 
  createAudioResource, 
  joinVoiceChannel, 
  AudioPlayerStatus, 
  VoiceConnectionStatus,
  getVoiceConnection,
  entersState,
  StreamType,
  generateDependencyReport
} = require('@discordjs/voice');
const ytdl = require('ytdl-core-discord');
const ytsr = require('ytsr');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const QRCode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const schedule = require('node-schedule');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== KIỂM TRA BIẾN MÔI TRƯỜNG =====
console.log(chalk.blue('🔍 Kiểm tra biến môi trường...'));
console.log(chalk.gray('DISCORD_CLIENT_ID:'), process.env.DISCORD_CLIENT_ID ? '✅' : '❌');
console.log(chalk.gray('DISCORD_CLIENT_SECRET:'), process.env.DISCORD_CLIENT_SECRET ? '✅' : '❌');
console.log(chalk.gray('DISCORD_TOKEN:'), process.env.DISCORD_TOKEN ? '✅' : '❌');
console.log(chalk.gray('GEMINI_API_KEY:'), process.env.GEMINI_API_KEY ? '✅' : '❌');

// ===== CẤU HÌNH PASSPORT & SESSION =====
app.use(session({
  secret: process.env.SESSION_SECRET || 'queen-premium-bot-secret-key-' + Math.random().toString(36),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

app.use(passport.initialize());
app.use(passport.session());

// ===== FIX LỖI PASSPORT - THÊM KIỂM TRA BIẾN MÔI TRƯỜNG =====
const discordStrategyConfig = {
  clientID: process.env.DISCORD_CLIENT_ID || 'MISSING_CLIENT_ID',
  clientSecret: process.env.DISCORD_CLIENT_SECRET || 'MISSING_CLIENT_SECRET',
  callbackURL: process.env.DISCORD_CALLBACK_URL || `http://localhost:${PORT}/auth/callback`,
  scope: ['identify', 'guilds']
};

// Kiểm tra xem có đủ thông tin cấu hình không
if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
  console.log(chalk.yellow('⚠️  Cảnh báo: DISCORD_CLIENT_ID hoặc DISCORD_CLIENT_SECRET chưa được cấu hình'));
  console.log(chalk.yellow('📝 Dashboard sẽ không hoạt động nhưng bot vẫn chạy bình thường'));
}

// ===== CẤU HÌNH PASSPORT DISCORD =====
passport.use(new DiscordStrategy(discordStrategyConfig, 
  (accessToken, refreshToken, profile, done) => {
    console.log(chalk.green(`🔐 User ${profile.username} đã đăng nhập`));
    return done(null, profile);
  }
));

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// ===== MIDDLEWARE XÁC THỰC =====
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/auth/discord');
}

function isBotOwner(req, res, next) {
  if (req.isAuthenticated() && req.user.id === process.env.BOT_OWNER_ID) {
    return next();
  }
  res.status(403).json({ error: 'Chỉ chủ bot mới có quyền truy cập' });
}

// ===== SỬA LỖI OPUS =====
try {
  require('@discordjs/opus');
} catch (error) {
  console.log(chalk.yellow('⚠️  @discordjs/opus không khả dụng, sử dụng opusscript...'));
  try {
    require('opusscript');
  } catch (err) {
    console.log(chalk.red('❌ Không thể tải opus codec!'));
  }
}

// ===== NÂNG CẤP CẤU HÌNH =====
let genAI;
if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
} else {
  console.log(chalk.yellow('⚠️  GEMINI_API_KEY chưa được cấu hình, tính năng AI sẽ không hoạt động'));
}

// Hệ thống music nâng cao
class MusicQueue {
  constructor() {
    this.guilds = new Map();
    this.players = new Map();
    this.connections = new Map();
  }

  get(guildId) {
    return this.guilds.get(guildId);
  }

  set(guildId, queue) {
    this.guilds.set(guildId, queue);
  }

  delete(guildId) {
    this.guilds.delete(guildId);
    this.players.delete(guildId);
    this.connections.delete(guildId);
  }

  initPlayer(guildId) {
    const player = createAudioPlayer();
    this.players.set(guildId, player);
    return player;
  }

  getPlayer(guildId) {
    return this.players.get(guildId);
  }
}

const musicQueue = new MusicQueue();
const activeGiveaways = new Map();
const ticketSystem = new Map();
const reactionRoles = new Map();

// ===== HỆ THỐNG TỰ ĐỘNG XÓA TIN NHẮN =====
class AutoDeleteSystem {
  constructor() {
    this.scheduledDeletions = new Map();
    this.autoDeleteEnabled = true;
    this.defaultDelay = 10000; // 10 giây
  }

  scheduleDeletion(messageId, channelId, delay = this.defaultDelay) {
    if (!this.autoDeleteEnabled) return;
    if (this.scheduledDeletions.has(messageId)) return;

    const timeout = setTimeout(async () => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel) {
          await channel.messages.delete(messageId).catch(() => {});
        }
      } catch (error) {
        console.error(chalk.red('Lỗi khi xóa tin nhắn:'), error.message);
      } finally {
        this.scheduledDeletions.delete(messageId);
      }
    }, delay);

    this.scheduledDeletions.set(messageId, timeout);
  }

  cancelDeletion(messageId) {
    if (this.scheduledDeletions.has(messageId)) {
      clearTimeout(this.scheduledDeletions.get(messageId));
      this.scheduledDeletions.delete(messageId);
    }
  }

  setAutoDelete(enabled) {
    this.autoDeleteEnabled = enabled;
  }

  getStats() {
    return {
      enabled: this.autoDeleteEnabled,
      scheduled: this.scheduledDeletions.size,
      defaultDelay: this.defaultDelay
    };
  }
}

const autoDeleteSystem = new AutoDeleteSystem();

// ===== KẾT NỐI DATABASE =====
if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log(gradient.rainbow('🗄️ Đã kết nối MongoDB')))
    .catch(err => console.error(chalk.red('❌ Lỗi MongoDB:'), err));
} else {
  console.log(chalk.yellow('⚠️  MONGODB_URI chưa được cấu hình, sử dụng database ảo'));
}

// ===== SCHEMA DATABASE =====
const userSchema = new mongoose.Schema({
  userId: String,
  guildId: String,
  xp: { type: Number, default: 0 },
  level: { type: Number, default: 1 },
  money: { type: Number, default: 0 },
  bank: { type: Number, default: 0 },
  lastDaily: Date,
  lastWork: Date,
  inventory: [{
    item: String,
    quantity: Number,
    obtainedAt: Date
  }],
  badges: [String],
  musicStats: {
    songsPlayed: { type: Number, default: 0 },
    timeListened: { type: Number, default: 0 },
    favoriteSongs: [String]
  },
  profileSettings: {
    autoDelete: { type: Boolean, default: true },
    privacy: { type: String, default: 'public' }
  }
});

const guildSchema = new mongoose.Schema({
  guildId: String,
  prefix: { type: String, default: '!' },
  welcomeChannel: String,
  logChannel: String,
  autoRole: String,
  modRoles: [String],
  musicSettings: {
    defaultVolume: { type: Number, default: 50 },
    maxQueueSize: { type: Number, default: 100 },
    djRole: String,
    allowPlaylists: { type: Boolean, default: true }
  },
  autoDeleteSettings: {
    enabled: { type: Boolean, default: true },
    delay: { type: Number, default: 10000 },
    exemptChannels: [String],
    exemptRoles: [String]
  }
});

const playlistSchema = new mongoose.Schema({
  userId: String,
  name: String,
  songs: [{
    title: String,
    url: String,
    duration: Number,
    thumbnail: String,
    addedAt: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Guild = mongoose.model('Guild', guildSchema);
const Playlist = mongoose.model('Playlist', playlistSchema);

// ===== CẤU HÌNH CONSOLE ĐẸP =====
console.clear();

function typeEffect(text, speed = 30) {
  return new Promise(resolve => {
    let i = 0;
    const interval = setInterval(() => {
      process.stdout.write(text[i]);
      i++;
      if (i >= text.length) {
        clearInterval(interval);
        console.log();
        resolve();
      }
    }, speed);
  });
}

async function showBanner() {
  console.log('\n'.repeat(2));
  await typeEffect(chalk.hex('#FF00FF')('🚀 Đang khởi động Queen Premium Bot...'), 50);
  
  return new Promise(resolve => {
    figlet.text('QUEEN  PREMIUM', {
      font: 'Block',
      horizontalLayout: 'default',
      verticalLayout: 'default',
      width: 80,
      whitespaceBreak: true
    }, (err, data) => {
      if (err) {
        console.log('Lỗi khi tạo banner');
        return resolve();
      }
      
      const lines = data.split('\n');
      let i = 0;
      const interval = setInterval(() => {
        if (i < lines.length) {
          console.log(gradient.rainbow(lines[i]));
          i++;
        } else {
          clearInterval(interval);
          console.log(gradient.passion('\n           👑 Một sản phẩm từ Queen Team - Bot Discord đa tính năng\n'));
          console.log(gradient.mind('           ⏰ Phiên bản Auto-Delete 6.0 - Tự động xóa tin nhắn sau 10s\n'));
          resolve();
        }
      }, 100);
    });
  });
}

function showSystemInfo() {
  const totalMem = os.totalmem() / 1024 / 1024 / 1024;
  const freeMem = os.freemem() / 1024 / 1024 / 1024;
  const usedMem = totalMem - freeMem;
  
  console.log(boxen(
    gradient.rainbow(`🤖 HỆ THỐNG THÔNG TIN\n`) +
    gradient.pastel(`📍 Platform: ${os.platform()} ${os.arch()}\n`) +
    gradient.pastel(`💾 RAM: ${usedMem.toFixed(2)}GB/${totalMem.toFixed(2)}GB\n`) +
    gradient.pastel(`🖥️ CPU: ${os.cpus()[0].model}\n`) +
    gradient.pastel(`⏰ Uptime: ${moment.duration(os.uptime(), 'seconds').humanize()}`),
    { 
      padding: 1, 
      margin: 1, 
      borderStyle: 'double',
      borderColor: 'cyan'
    }
  ));
}

async function initConsoleEffects() {
  await showBanner();
  await new Promise(resolve => setTimeout(resolve, 500));
  showSystemInfo();
  
  console.log(gradient.rainbow('\n🎵 HỆ THỐNG AUDIO:'));
  console.log(generateDependencyReport());
}

initConsoleEffects();

// ===== WEB DASHBOARD ROUTES =====
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// ===== ROUTES AUTH =====
app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/callback',
  passport.authenticate('discord', { 
    failureRedirect: '/login-failed' 
  }),
  (req, res) => {
    res.redirect('/dashboard');
  }
);

app.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      return next(err);
    }
    res.redirect('/');
  });
});

// ===== REAL-TIME API ENDPOINTS =====

// Real-time bot stats với SSE (Server-Sent Events)
app.get('/api/real-time/stats', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const sendStats = () => {
    const stats = {
      serverCount: client.guilds?.cache?.size || 0,
      userCount: client.users?.cache?.size || 0,
      uptime: moment.duration(process.uptime(), 'seconds').humanize(),
      commands: 30,
      autoDeleteStats: autoDeleteSystem.getStats(),
      timestamp: new Date().toISOString(),
      memoryUsage: process.memoryUsage(),
      platform: process.platform,
      nodeVersion: process.version
    };
    
    res.write(`data: ${JSON.stringify(stats)}\n\n`);
  };

  // Gửi dữ liệu ngay lập tức
  sendStats();
  
  // Gửi dữ liệu mỗi 5 giây
  const interval = setInterval(sendStats, 5000);

  // Cleanup khi client disconnect
  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

// Real-time bot status với SSE
app.get('/api/real-time/bot-status', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const sendStatus = () => {
    const status = {
      status: client.ws.status === 0 ? 'online' : 'offline',
      ping: client.ws.ping,
      readyAt: client.readyAt,
      guilds: client.guilds.cache.size,
      users: client.users.cache.size,
      channels: client.channels.cache.size,
      timestamp: new Date().toISOString()
    };
    
    res.write(`data: ${JSON.stringify(status)}\n\n`);
  };

  sendStatus();
  const interval = setInterval(sendStatus, 3000);

  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

// ===== ROUTES CHÍNH =====
app.get('/', (req, res) => {
  const uptime = moment.duration(process.uptime(), 'seconds').humanize();
  
  res.render('index', {
    user: req.user,
    botStats: {
      status: 'success', 
      message: '✅ Queen Premium Discord Bot is running!',
      version: '6.0.0',
      features: [
        'Auto-Delete System', 'Advanced Avatar System', 'User Profile', 'Welcome Images',
        'Music System', 'Playlist Management', 'Audio Effects', '24/7 Music', 
        'Level System', 'Economy System', 'Moderation Tools', 'AI Chat', 
        'Mini Games', 'Giveaway System', 'Ticket System', 'Auto Role', 
        'Reaction Roles', 'Custom Embeds', 'Poll System', 'Inventory System'
      ],
      uptime: uptime,
      serverCount: client.guilds?.cache?.size || 0,
      userCount: client.users?.cache?.size || 0,
      autoDeleteStats: autoDeleteSystem.getStats(),
      timestamp: new Date().toISOString()
    },
    realTimeConfig: {
      enabled: true,
      endpoints: {
        stats: '/api/real-time/stats',
        botStatus: '/api/real-time/bot-status'
      }
    }
  });
});

app.get('/dashboard', ensureAuthenticated, (req, res) => {
  res.render('dashboard', {
    user: req.user,
    bot: client.user,
    stats: {
      serverCount: client.guilds?.cache?.size || 0,
      userCount: client.users?.cache?.size || 0,
      uptime: moment.duration(process.uptime(), 'seconds').humanize(),
      commands: 30,
      autoDeleteStats: autoDeleteSystem.getStats()
    },
    realTimeConfig: {
      enabled: true,
      endpoints: {
        stats: '/api/real-time/stats',
        botStatus: '/api/real-time/bot-status',
        activity: '/api/real-time/activity'
      }
    }
  });
});

// Real-time activity feed
app.get('/api/real-time/activity', ensureAuthenticated, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const sendActivity = () => {
    // Mock activity data - trong thực tế sẽ lấy từ database hoặc hệ thống logging
    const activities = [
      {
        id: Date.now(),
        type: 'success',
        icon: 'fa-check',
        title: 'Auto-Delete system started',
        time: '2 minutes ago',
        color: '#3BA55D'
      },
      {
        id: Date.now() + 1,
        type: 'info',
        icon: 'fa-user',
        title: 'User executed !avatar command',
        time: '5 minutes ago',
        color: '#5865F2'
      },
      {
        id: Date.now() + 2,
        type: 'warning',
        icon: 'fa-music',
        title: 'Music queue cleared by user',
        time: '10 minutes ago',
        color: '#FAA81A'
      }
    ];

    const randomActivity = activities[Math.floor(Math.random() * activities.length)];
    res.write(`data: ${JSON.stringify(randomActivity)}\n\n`);
  };

  // Gửi activity mỗi 10-30 giây ngẫu nhiên
  const sendRandomActivity = () => {
    sendActivity();
    setTimeout(sendRandomActivity, Math.random() * 20000 + 10000);
  };

  sendRandomActivity();

  req.on('close', () => {
    res.end();
  });
});

// ===== ROUTE MUSIC MANAGEMENT =====
app.get('/dashboard/music', ensureAuthenticated, async (req, res) => {
    try {
        const guilds = await getManagedGuilds(req.user.id);
        const activeMusicServers = await getActiveMusicServers(req.user.id);

        res.render('music', {
            user: req.user,
            guilds: guilds,
            activeMusicServers: activeMusicServers,
            musicStats: {
                totalPlaytime: '1,234 giờ',
                songsPlayed: '45,678',
                mostPlayed: 'Shape of You - Ed Sheeran',
                queueSize: '15 bài hát'
            },
            realTimeConfig: {
                enabled: true,
                endpoints: {
                    musicStatus: '/api/real-time/music/status',
                    musicQueue: '/api/real-time/music/queue'
                }
            }
        });
    } catch (error) {
        console.error('Error loading music page:', error);
        res.status(500).render('error', { 
            user: req.user,
            error: 'Không thể tải trang quản lý music' 
        });
    }
});

// Real-time music status với SSE
app.get('/api/real-time/music/status', ensureAuthenticated, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const sendMusicStatus = async () => {
        try {
            const activeServers = await getActiveMusicServers(req.user.id);
            const guilds = await getManagedGuilds(req.user.id);
            
            const musicStats = {
                activeServers: activeServers.length,
                totalPlaytime: '1,234 giờ',
                songsPlayed: '45,678',
                mostPlayed: 'Shape of You - Ed Sheeran',
                totalQueued: activeServers.reduce((sum, server) => sum + (server.queueLength || 0), 0)
            };

            const statusData = {
                success: true,
                activeServers: activeServers,
                availableGuilds: guilds,
                stats: musicStats,
                timestamp: new Date().toISOString()
            };

            res.write(`data: ${JSON.stringify(statusData)}\n\n`);
        } catch (error) {
            const errorData = {
                success: false,
                error: 'Failed to get real-time music status',
                timestamp: new Date().toISOString()
            };
            res.write(`data: ${JSON.stringify(errorData)}\n\n`);
        }
    };

    sendMusicStatus();
    const interval = setInterval(sendMusicStatus, 3000);

    req.on('close', () => {
        clearInterval(interval);
        res.end();
    });
});

// Real-time music queue updates
app.get('/api/real-time/music/queue/:guildId', ensureAuthenticated, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const sendQueueUpdate = async () => {
        try {
            const guild = client.guilds.cache.get(req.params.guildId);
            if (!guild) {
                res.write(`data: ${JSON.stringify({ error: 'Server not found' })}\n\n`);
                return;
            }

            // Check if user has access to this guild
            const member = guild.members.cache.get(req.user.id);
            if (!member) {
                res.write(`data: ${JSON.stringify({ error: 'Access denied' })}\n\n`);
                return;
            }

            // Get music queue from your music system
            const queue = musicQueue.get(guild.id);
            const queueData = queue ? queue.songs.map((song, index) => ({
                id: index,
                title: song.title,
                artist: 'Unknown Artist',
                duration: song.duration,
                thumbnail: song.thumbnail,
                requestedBy: song.requestedBy,
                url: song.url
            })) : [];

            const queueUpdate = {
                success: true,
                queue: queueData,
                nowPlaying: queue?.currentSong || null,
                isPlaying: queue?.playing || false,
                volume: queue?.volume || 100,
                loopMode: queue?.loopMode || 'off',
                timestamp: new Date().toISOString()
            };

            res.write(`data: ${JSON.stringify(queueUpdate)}\n\n`);
        } catch (error) {
            res.write(`data: ${JSON.stringify({ 
                success: false, 
                error: 'Failed to get music queue' 
            })}\n\n`);
        }
    };

    sendQueueUpdate();
    const interval = setInterval(sendQueueUpdate, 2000);

    req.on('close', () => {
        clearInterval(interval);
        res.end();
    });
});

// API endpoint to get music queue (one-time request)
app.get('/api/music/queue/:guildId', ensureAuthenticated, async (req, res) => {
    try {
        const guild = client.guilds.cache.get(req.params.guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Server not found' });
        }

        // Check if user has access to this guild
        const member = guild.members.cache.get(req.user.id);
        if (!member) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Get music queue from your music system
        const queue = musicQueue.get(guild.id);
        const queueData = queue ? queue.songs.map((song, index) => ({
            id: index,
            title: song.title,
            artist: 'Unknown Artist',
            duration: song.duration,
            thumbnail: song.thumbnail,
            requestedBy: song.requestedBy,
            url: song.url
        })) : [];

        res.json({
            success: true,
            queue: queueData,
            nowPlaying: queue?.currentSong || null,
            isPlaying: queue?.playing || false,
            volume: queue?.volume || 100,
            loopMode: queue?.loopMode || 'off',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to get music queue'
        });
    }
});

// API endpoint to control music playback
app.post('/api/music/control/:guildId', ensureAuthenticated, async (req, res) => {
    try {
        const { action, value } = req.body;
        const guild = client.guilds.cache.get(req.params.guildId);
        
        if (!guild) {
            return res.status(404).json({ error: 'Server not found' });
        }

        const member = guild.members.cache.get(req.user.id);
        if (!member) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Handle different music control actions
        let result;
        switch (action) {
            case 'play':
                if (musicSystem && musicSystem.play) {
                    result = await musicSystem.play(guild.id, value);
                }
                break;
            case 'pause':
                if (musicSystem && musicSystem.pause) {
                    result = await musicSystem.pause(guild.id);
                }
                break;
            case 'skip':
                if (musicSystem && musicSystem.skip) {
                    result = await musicSystem.skip(guild.id);
                }
                break;
            case 'volume':
                if (musicSystem && musicSystem.setVolume) {
                    result = await musicSystem.setVolume(guild.id, parseInt(value));
                }
                break;
            case 'shuffle':
                if (musicSystem && musicSystem.shuffle) {
                    result = await musicSystem.shuffle(guild.id);
                }
                break;
            case 'loop':
                if (musicSystem && musicSystem.setLoop) {
                    result = await musicSystem.setLoop(guild.id, value);
                }
                break;
            case 'stop':
                if (musicSystem && musicSystem.stop) {
                    result = await musicSystem.stop(guild.id);
                }
                break;
            default:
                return res.status(400).json({ error: 'Invalid action' });
        }

        res.json({
            success: true,
            message: `Music ${action} executed successfully`,
            result: result,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to control music playback: ' + error.message
        });
    }
});

// API endpoint to get active music servers
app.get('/api/music/active-servers', ensureAuthenticated, async (req, res) => {
    try {
        const activeServers = await getActiveMusicServers(req.user.id);
        
        res.json({
            success: true,
            servers: activeServers,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to get active music servers'
        });
    }
});

// ===== ROUTE SETTINGS MANAGEMENT =====
app.get('/dashboard/settings', ensureAuthenticated, async (req, res) => {
    try {
        res.render('settings', {
            user: req.user,
            botSettings: {
                version: '6.0.0',
                uptime: moment.duration(process.uptime(), 'seconds').humanize(),
                totalServers: client.guilds.cache.size,
                totalUsers: client.users.cache.size
            },
            realTimeConfig: {
                enabled: true,
                endpoints: {
                    settingsStatus: '/api/real-time/settings/status'
                }
            }
        });
    } catch (error) {
        console.error('Error loading settings page:', error);
        res.status(500).render('error', { 
            user: req.user,
            error: 'Không thể tải trang cài đặt' 
        });
    }
});

// Real-time settings status với SSE
app.get('/api/real-time/settings/status', ensureAuthenticated, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const sendSettingsStatus = () => {
        const settingsData = {
            botSettings: {
                version: '6.0.0',
                uptime: moment.duration(process.uptime(), 'seconds').humanize(),
                totalServers: client.guilds.cache.size,
                totalUsers: client.users.cache.size,
                memoryUsage: process.memoryUsage(),
                platform: process.platform
            },
            timestamp: new Date().toISOString()
        };

        res.write(`data: ${JSON.stringify(settingsData)}\n\n`);
    };

    sendSettingsStatus();
    const interval = setInterval(sendSettingsStatus, 10000); // 10 giây

    req.on('close', () => {
        clearInterval(interval);
        res.end();
    });
});

// API endpoint to save settings
app.post('/api/settings/save', ensureAuthenticated, async (req, res) => {
    try {
        const { category, settings } = req.body;
        
        // Validate settings
        if (!category || !settings) {
            return res.status(400).json({
                success: false,
                error: 'Invalid settings data'
            });
        }

        // In a real application, you would save these settings to a database
        console.log(`Saving ${category} settings:`, settings);

        res.json({
            success: true,
            message: 'Settings saved successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error saving settings:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to save settings'
        });
    }
});

// API endpoint to reset settings
app.post('/api/settings/reset', ensureAuthenticated, async (req, res) => {
    try {
        const { category } = req.body;
        
        if (!category) {
            return res.status(400).json({
                success: false,
                error: 'Category is required'
            });
        }

        // Implement reset logic based on category
        console.log(`Resetting ${category} settings to defaults`);

        res.json({
            success: true,
            message: `${category} settings reset to defaults`,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to reset settings'
        });
    }
});

// API endpoint to export settings
app.get('/api/settings/export', ensureAuthenticated, async (req, res) => {
    try {
        // Gather all current settings
        const settings = {
            general: {
                // General settings would go here
            },
            bot: {
                // Bot settings would go here
            },
            music: {
                // Music settings would go here
            },
            autodelete: {
                // Auto-delete settings would go here
            },
            exportDate: new Date().toISOString(),
            version: '6.0.0'
        };

        res.json({
            success: true,
            settings: settings,
            filename: `queen_premium_settings_${Date.now()}.json`
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to export settings'
        });
    }
});

// API endpoint to import settings
app.post('/api/settings/import', ensureAuthenticated, async (req, res) => {
    try {
        const { settings } = req.body;
        
        if (!settings) {
            return res.status(400).json({
                success: false,
                error: 'Settings data is required'
            });
        }

        // Validate and apply imported settings
        console.log('Importing settings:', settings);

        res.json({
            success: true,
            message: 'Settings imported successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to import settings'
        });
    }
});

// ===== ROUTE SERVERS MANAGEMENT =====
app.get('/dashboard/servers', ensureAuthenticated, async (req, res) => {
    try {
        const guilds = await getManagedGuilds(req.user.id);
        
        // Calculate statistics
        const totalMembers = guilds.reduce((sum, guild) => sum + guild.memberCount, 0);
        const managedServers = guilds.filter(guild => guild.owner).length;
        const largeServers = guilds.filter(guild => guild.memberCount > 500).length;
        
        res.render('servers', {
            user: req.user,
            guilds: guilds,
            totalMembers: totalMembers,
            managedServers: managedServers,
            largeServers: largeServers,
            getRandomColor: () => {
                const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'];
                return colors[Math.floor(Math.random() * colors.length)];
            },
            realTimeConfig: {
                enabled: true,
                endpoints: {
                    servers: '/api/real-time/servers'
                }
            }
        });
    } catch (error) {
        console.error('Error loading servers page:', error);
        res.status(500).render('error', { 
            user: req.user,
            error: 'Không thể tải trang quản lý servers' 
        });
    }
});

// Real-time servers data với SSE
app.get('/api/real-time/servers', ensureAuthenticated, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const sendServersData = async () => {
        try {
            const guilds = await getManagedGuilds(req.user.id);
            
            const stats = {
                totalMembers: guilds.reduce((sum, guild) => sum + guild.memberCount, 0),
                managedServers: guilds.filter(guild => guild.owner).length,
                largeServers: guilds.filter(guild => guild.memberCount > 500).length,
                totalServers: guilds.length,
                onlineMembers: guilds.reduce((sum, guild) => sum + (guild.approximatePresenceCount || 0), 0)
            };

            const serversData = {
                success: true,
                guilds: guilds,
                stats: stats,
                timestamp: new Date().toISOString()
            };

            res.write(`data: ${JSON.stringify(serversData)}\n\n`);
        } catch (error) {
            res.write(`data: ${JSON.stringify({
                success: false,
                error: 'Failed to get real-time servers data'
            })}\n\n`);
        }
    };

    sendServersData();
    const interval = setInterval(sendServersData, 8000); // 8 giây

    req.on('close', () => {
        clearInterval(interval);
        res.end();
    });
});

// Helper function to get managed guilds với xử lý BigInt
async function getManagedGuilds(userId) {
    try {
        // Function to safely serialize data with BigInt handling
        function safeSerialize(obj) {
            return JSON.parse(JSON.stringify(obj, (key, value) =>
                typeof value === 'bigint' ? value.toString() : value
            ));
        }

        const guilds = client.guilds.cache.map(guild => {
            const member = guild.members.cache.get(userId);
            return safeSerialize({
                id: guild.id,
                name: guild.name,
                icon: guild.iconURL(),
                memberCount: guild.memberCount,
                owner: guild.ownerId === userId,
                created: guild.createdAt,
                region: guild.preferredLocale,
                features: guild.features,
                permissions: member ? member.permissions.bitfield : 0,
                approximateMemberCount: guild.approximateMemberCount,
                approximatePresenceCount: guild.approximatePresenceCount,
                premiumTier: guild.premiumTier,
                premiumSubscriptionCount: guild.premiumSubscriptionCount,
                description: guild.description,
                verified: guild.verified,
                partnered: guild.partnered
            });
        });
        
        return guilds.sort((a, b) => b.memberCount - a.memberCount);
    } catch (error) {
        console.error('Error getting managed guilds:', error);
        return [];
    }
}

// Helper function to get active music servers
async function getActiveMusicServers(userId) {
    try {
        const guilds = await getManagedGuilds(userId);
        const activeServers = [];
        
        for (const guild of guilds) {
            const queue = musicQueue.get(guild.id);
            if (queue && (queue.playing || queue.songs?.length > 0)) {
                const voiceChannel = client.channels.cache.get(queue.connection?.joinConfig?.channelId);
                
                activeServers.push({
                    id: guild.id,
                    name: guild.name,
                    icon: guild.icon,
                    memberCount: guild.memberCount,
                    musicStatus: queue.currentSong ? `Đang phát: ${queue.currentSong.title}` : 'Đang chờ...',
                    currentListeners: voiceChannel ? voiceChannel.members.size - 1 : 0,
                    currentSong: queue.currentSong,
                    queueLength: queue.songs ? queue.songs.length : 0,
                    isPlaying: queue.playing || false,
                    volume: queue.volume || 100,
                    loopMode: queue.loopMode || 'off',
                    duration: queue.currentSong?.duration || '0:00',
                    progress: queue.currentTime || 0
                });
            }
        }

        return activeServers;
    } catch (error) {
        console.error('Error getting active music servers:', error);
        return [];
    }
}

// API endpoint to refresh servers (one-time request)
app.get('/api/servers/refresh', ensureAuthenticated, async (req, res) => {
    try {
        const guilds = await getManagedGuilds(req.user.id);
        res.json({
            success: true,
            guilds: guilds,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to refresh servers'
        });
    }
});

// API endpoint to get server details
app.get('/api/server/:id', ensureAuthenticated, async (req, res) => {
    try {
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) {
            return res.status(404).json({ error: 'Server not found' });
        }

        // Check if user has access to this guild
        const member = guild.members.cache.get(req.user.id);
        if (!member) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Safe serialize function for BigInt
        function safeSerialize(obj) {
            return JSON.parse(JSON.stringify(obj, (key, value) =>
                typeof value === 'bigint' ? value.toString() : value
            ));
        }

        const serverData = safeSerialize({
            id: guild.id,
            name: guild.name,
            icon: guild.iconURL({ size: 512, dynamic: true }),
            banner: guild.bannerURL({ size: 1024 }),
            splash: guild.splashURL({ size: 1024 }),
            memberCount: guild.memberCount,
            owner: guild.ownerId === req.user.id,
            created: guild.createdAt,
            region: guild.preferredLocale,
            features: guild.features,
            channels: guild.channels.cache.size,
            roles: guild.roles.cache.size,
            emojis: guild.emojis.cache.size,
            boostLevel: guild.premiumTier,
            boostCount: guild.premiumSubscriptionCount,
            approximateMemberCount: guild.approximateMemberCount,
            approximatePresenceCount: guild.approximatePresenceCount,
            description: guild.description,
            verified: guild.verified,
            partnered: guild.partnered,
            rulesChannel: guild.rulesChannel?.name,
            systemChannel: guild.systemChannel?.name,
            afkChannel: guild.afkChannel?.name,
            afkTimeout: guild.afkTimeout,
            mfaLevel: guild.mfaLevel,
            verificationLevel: guild.verificationLevel,
            explicitContentFilter: guild.explicitContentFilter,
            defaultMessageNotifications: guild.defaultMessageNotifications,
            premiumProgressBarEnabled: guild.premiumProgressBarEnabled
        });

        res.json(serverData);
    } catch (error) {
        console.error('Error getting server details:', error);
        res.status(500).json({ error: 'Failed to get server details' });
    }
});

// API endpoint to get server channels
app.get('/api/server/:id/channels', ensureAuthenticated, async (req, res) => {
    try {
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) {
            return res.status(404).json({ error: 'Server not found' });
        }

        const member = guild.members.cache.get(req.user.id);
        if (!member) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const channels = guild.channels.cache.map(channel => ({
            id: channel.id,
            name: channel.name,
            type: channel.type,
            position: channel.position,
            parentId: channel.parentId,
            topic: channel.topic,
            nsfw: channel.nsfw,
            rateLimitPerUser: channel.rateLimitPerUser
        }));

        res.json(channels);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get server channels' });
    }
});

// API endpoint for bot stats (one-time request)
app.get('/api/stats', (req, res) => {
  res.json({
    serverCount: client.guilds?.cache?.size || 0,
    userCount: client.users?.cache?.size || 0,
    uptime: moment.duration(process.uptime(), 'seconds').humanize(),
    commands: 30,
    autoDeleteStats: autoDeleteSystem.getStats(),
    timestamp: new Date().toISOString()
  });
});

// API endpoint to get all guilds (bot owner only)
app.get('/api/guilds', ensureAuthenticated, isBotOwner, async (req, res) => {
  try {
    const guilds = client.guilds.cache.map(guild => ({
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL(),
      memberCount: guild.memberCount,
      owner: guild.ownerId === req.user.id
    }));
    
    res.json(guilds);
  } catch (error) {
    res.status(500).json({ error: 'Lỗi khi lấy danh sách server' });
  }
});

// API endpoint to get specific guild details
app.get('/api/guild/:id', ensureAuthenticated, isBotOwner, async (req, res) => {
  try {
    const guild = client.guilds.cache.get(req.params.id);
    if (!guild) {
      return res.status(404).json({ error: 'Không tìm thấy server' });
    }

    const guildData = {
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL(),
      memberCount: guild.memberCount,
      channels: guild.channels.cache.size,
      roles: guild.roles.cache.size,
      owner: guild.ownerId,
      created: guild.createdAt,
      features: guild.features
    };

    res.json(guildData);
  } catch (error) {
    res.status(500).json({ error: 'Lỗi khi lấy thông tin server' });
  }
});

// API endpoint to restart bot
app.post('/api/bot/restart', ensureAuthenticated, isBotOwner, (req, res) => {
  res.json({ 
    success: true,
    message: 'Đang khởi động lại bot...',
    timestamp: new Date().toISOString()
  });
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

// Login failed page
app.get('/login-failed', (req, res) => {
  res.render('login-failed', { user: null });
});

// Middleware để đảm bảo người dùng đã xác thực
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/auth/discord');
}

// Middleware để kiểm tra bot owner
function isBotOwner(req, res, next) {
  if (req.user && req.user.id === process.env.BOT_OWNER_ID) {
    return next();
  }
  res.status(403).json({ error: 'Access denied' });
}

// Middleware logging
app.use((req, res, next) => {
  const timestamp = chalk.gray(moment().format('YYYY-MM-DD HH:mm:ss'));
  const method = chalk.bold.cyan(req.method);
  const url = chalk.white(req.url);
  const ip = chalk.yellow(req.ip || req.connection.remoteAddress);
  
  console.log(`${timestamp} ${method} ${url} from ${ip}`);
  next();
});

app.listen(PORT, () => {
  const message = `🌐 Web server running on port ${PORT}`;
  console.log(boxen(gradient.rainbow(message), { 
    padding: 1, 
    margin: 1, 
    borderStyle: 'round',
    borderColor: 'magenta'
  }));
});

// ===== DISCORD BOT =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildModeration
  ]
});

const config = {
  autoDeleteDelay: 10000, // 10 giây
  defaultImageSize: 4096,
  colors: {
    primary: '#5865F2',
    error: '#ED4245',
    success: '#3BA55D',
    warning: '#FAA81A',
    info: '#57F287',
    music: '#EB459E',
    fun: '#FEE75C',
    ai: '#9C84EF',
    economy: '#F1C40F',
    moderation: '#E74C3C',
    games: '#9B59B6',
    spotify: '#1DB954',
    soundcloud: '#FF3300',
    profile: '#9C27B0',
    delete: '#FF6B6B'
  },
  cooldown: 3000,
  prefix: '!'
};

// ===== HỆ THỐNG MUSIC CAO CẤP =====
class AdvancedMusicSystem {
  constructor() {
    this.radioStations = new Map([
      ['vpop', { name: '🎵 V-Pop Radio', url: 'https://stream.zeno.fm/0r0xa792kwzuv' }],
      ['usuk', { name: '🎧 US-UK Radio', url: 'https://stream.zeno.fm/0r0xa792kwzuv' }],
      ['edm', { name: '🎛️ EDM Radio', url: 'https://stream.zeno.fm/0r0xa792kwzuv' }],
      ['lofi', { name: '🎶 Lofi Radio', url: 'https://stream.zeno.fm/0r0xa792kwzuv' }],
      ['kpop', { name: '🌟 K-Pop Radio', url: 'https://stream.zeno.fm/0r0xa792kwzuv' }]
    ]);
  }

  async searchYouTube(query) {
    try {
      const search = await ytsr(query, { limit: 10 });
      
      return search.items.filter(item => item.type === 'video').map(item => ({
        title: item.title,
        url: item.url,
        duration: item.duration,
        thumbnail: item.bestThumbnail?.url,
        views: item.views,
        author: item.author?.name
      }));
    } catch (error) {
      console.error('YouTube Search Error:', error);
      return [];
    }
  }

  formatTime(seconds) {
    if (isNaN(seconds)) return '0:00';
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  createProgressBar(current, total, length = 20) {
    const percentage = current / total;
    const progress = Math.round(length * percentage);
    const empty = length - progress;
    
    return '█'.repeat(progress) + '░'.repeat(empty);
  }

  async getLyrics(title) {
    try {
      const response = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(title.split('-')[0])}/${encodeURIComponent(title.split('-')[1] || title)}`);
      return response.data.lyrics || 'Không tìm thấy lời bài hát';
    } catch (error) {
      return 'Không thể tải lời bài hát';
    }
  }
}

const musicSystem = new AdvancedMusicSystem();

// ===== HỆ THỐNG AVATAR & PROFILE NÂNG CAO =====
class AdvancedAvatarSystem {
  constructor() {
    this.avatarCache = new Map();
  }

  async getUserAvatar(user, size = 1024) {
    try {
      const cacheKey = `${user.id}-${size}`;
      if (this.avatarCache.has(cacheKey)) {
        return this.avatarCache.get(cacheKey);
      }

      const avatarURL = user.displayAvatarURL({ 
        extension: 'png', 
        size: size,
        dynamic: true 
      });

      this.avatarCache.set(cacheKey, avatarURL);
      return avatarURL;
    } catch (error) {
      console.error('Lỗi khi lấy avatar:', error);
      return null;
    }
  }

  async findUserById(guild, userId) {
    try {
      let user = guild.members.cache.get(userId)?.user;
      if (!user) {
        const member = await guild.members.fetch(userId).catch(() => null);
        user = member?.user;
      }
      return user;
    } catch (error) {
      console.error('Lỗi khi tìm user:', error);
      return null;
    }
  }

  async findUserByUsername(guild, username) {
    try {
      const users = guild.members.cache.filter(member => 
        member.user.username.toLowerCase().includes(username.toLowerCase()) ||
        member.user.tag.toLowerCase().includes(username.toLowerCase())
      );
      
      return users.size > 0 ? users.first().user : null;
    } catch (error) {
      console.error('Lỗi khi tìm user bằng username:', error);
      return null;
    }
  }

  async createProfileImage(user, guildMember) {
    const canvas = createCanvas(800, 400);
    const ctx = canvas.getContext('2d');

    // Tạo gradient background
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#667eea');
    gradient.addColorStop(1, '#764ba2');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Vẽ pattern
    for (let i = 0; i < 50; i++) {
      const x = Math.random() * canvas.width;
      const y = Math.random() * canvas.height;
      const radius = Math.random() * 2;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.fill();
    }

    // Vẽ avatar
    try {
      const avatar = await loadImage(user.displayAvatarURL({ extension: 'jpg', size: 256 }));
      
      ctx.save();
      ctx.beginPath();
      ctx.arc(150, 200, 80, 0, Math.PI * 2, true);
      ctx.closePath();
      ctx.clip();
      
      ctx.drawImage(avatar, 70, 120, 160, 160);
      ctx.restore();

      // Vẽ viền avatar
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(150, 200, 83, 0, Math.PI * 2, true);
      ctx.stroke();
    } catch (err) {
      console.error('Lỗi khi tải avatar:', err);
    }

    // Thông tin user
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px Arial';
    ctx.fillText(user.username, 300, 150);
    
    ctx.font = '20px Arial';
    ctx.fillText(`ID: ${user.id}`, 300, 190);
    ctx.fillText(`Tag: ${user.tag}`, 300, 220);
    
    if (guildMember) {
      ctx.fillText(`Nickname: ${guildMember.nickname || 'Không có'}`, 300, 250);
      ctx.fillText(`Tham gia: ${guildMember.joinedAt ? guildMember.joinedAt.toLocaleDateString('vi-VN') : 'Không rõ'}`, 300, 280);
    }
    
    ctx.fillText(`Tạo tài khoản: ${user.createdAt.toLocaleDateString('vi-VN')}`, 300, 310);

    // Vẽ badge
    ctx.fillStyle = '#FFD700';
    ctx.font = 'bold 24px Arial';
    ctx.fillText('👑 QUEEN PREMIUM PROFILE', 200, 360);

    return canvas.toBuffer();
  }

  async createAvatarCollage(users, size = 400) {
    const canvasSize = Math.ceil(Math.sqrt(users.length)) * 200;
    const canvas = createCanvas(canvasSize, canvasSize);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#2C2F33';
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    let x = 0, y = 0;
    for (const user of users.slice(0, 16)) {
      try {
        const avatar = await loadImage(user.displayAvatarURL({ extension: 'jpg', size: 128 }));
        ctx.drawImage(avatar, x, y, 200, 200);
        
        x += 200;
        if (x >= canvasSize) {
          x = 0;
          y += 200;
        }
      } catch (err) {
        console.error('Lỗi khi tải avatar cho collage:', err);
      }
    }

    return canvas.toBuffer();
  }
}

const avatarSystem = new AdvancedAvatarSystem();

// ===== HÀM PHÁT NHẠC =====
async function playMusic(guildId) {
  const queue = musicQueue.get(guildId);
  if (!queue || queue.songs.length === 0) {
    setTimeout(() => {
      const connection = getVoiceConnection(guildId);
      if (connection && (!queue || queue.songs.length === 0)) {
        connection.destroy();
        musicQueue.delete(guildId);
      }
    }, 60000);
    return;
  }

  const song = queue.songs[0];
  const player = musicQueue.getPlayer(guildId) || musicQueue.initPlayer(guildId);

  try {
    let connection = getVoiceConnection(guildId);
    if (!connection) {
      connection = joinVoiceChannel({
        channelId: queue.voiceChannel.id,
        guildId: guildId,
        adapterCreator: queue.voiceChannel.guild.voiceAdapterCreator,
      });
    }

    const stream = await ytdl(song.url, {
      filter: 'audioonly',
      quality: 'highestaudio',
      highWaterMark: 1 << 25,
    });

    const resource = createAudioResource(stream, {
      inputType: StreamType.Opus,
      inlineVolume: true
    });

    resource.volume.setVolume(queue.volume / 100);

    queue.connection = connection;
    queue.resource = resource;
    
    connection.subscribe(player);
    player.play(resource);

    queue.playing = true;
    queue.currentSong = song;
    queue.startTime = Date.now();

    const embed = new EmbedBuilder()
      .setTitle('🎵 Đang phát')
      .setDescription(`[${song.title}](${song.url})`)
      .addFields(
        { name: '⏱️ Thời lượng', value: musicSystem.formatTime(song.duration), inline: true },
        { name: '👤 Yêu cầu bởi', value: song.requestedBy, inline: true },
        { name: '📊 Vị trí', value: `1/${queue.songs.length}`, inline: true }
      )
      .setThumbnail(song.thumbnail || 'https://i.imgur.com/8Q7YQ9e.png')
      .setColor(config.colors.music)
      .setFooter({ text: `Sử dụng !skip để chuyển bài | Volume: ${queue.volume}%` });

    const msg = await queue.textChannel.send({ embeds: [embed] });
    autoDeleteSystem.scheduleDeletion(msg.id, msg.channelId, 30000);

    player.once(AudioPlayerStatus.Idle, () => {
      if (queue.loop === 'song') {
        queue.songs.unshift(song);
      } else if (queue.loop === 'queue') {
        queue.songs.push(song);
      }
      
      queue.songs.shift();
      setTimeout(() => playMusic(guildId), 1000);
    });

    player.on('error', error => {
      console.error(chalk.red('Lỗi phát nhạc:'), error);
      queue.textChannel.send('❌ Có lỗi khi phát bài hát này, đang chuyển sang bài tiếp theo...')
        .then(msg => autoDeleteSystem.scheduleDeletion(msg.id, msg.channelId, 5000));
      queue.songs.shift();
      setTimeout(() => playMusic(guildId), 1000);
    });

  } catch (error) {
    console.error(chalk.red('Lỗi phát nhạc:'), error);
    queue.textChannel.send('❌ Lỗi khi kết nối hoặc phát nhạc!')
      .then(msg => autoDeleteSystem.scheduleDeletion(msg.id, msg.channelId, 5000));
    queue.songs.shift();
    setTimeout(() => playMusic(guildId), 1000);
  }
}

// ===== LỆNH AVATAR & PROFILE VỚI TỰ ĐỘNG XÓA =====
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(config.prefix)) return;

  const args = message.content.slice(config.prefix.length).trim().split(/ +/);
  const command = args.shift()?.toLowerCase();

  // ===== LỆNH AUTODELETE SETTINGS =====
  if (command === 'autodelete' || command === 'ad') {
    (async () => {
      try {
        const subcommand = args[0]?.toLowerCase();
        
        if (subcommand === 'on') {
          autoDeleteSystem.setAutoDelete(true);
          const reply = await message.reply('✅ **Đã bật hệ thống tự động xóa tin nhắn**\n📝 Tin nhắn của bot sẽ tự động xóa sau 10 giây');
          autoDeleteSystem.scheduleDeletion(reply.id, reply.channelId);
        }
        else if (subcommand === 'off') {
          autoDeleteSystem.setAutoDelete(false);
          const reply = await message.reply('❌ **Đã tắt hệ thống tự động xóa tin nhắn**');
          autoDeleteSystem.scheduleDeletion(reply.id, reply.channelId);
        }
        else if (subcommand === 'stats') {
          const stats = autoDeleteSystem.getStats();
          const embed = new EmbedBuilder()
            .setTitle('📊 Thống kê Auto-Delete')
            .setColor(config.colors.delete)
            .addFields(
              { name: '🔧 Trạng thái', value: stats.enabled ? '✅ Bật' : '❌ Tắt', inline: true },
              { name: '⏰ Thời gian', value: `${stats.defaultDelay/1000} giây`, inline: true },
              { name: '📋 Đang chờ xóa', value: `${stats.scheduled} tin nhắn`, inline: true }
            )
            .setFooter({ text: 'Sử dụng !autodelete on/off để bật/tắt' });

          const reply = await message.reply({ embeds: [embed] });
          autoDeleteSystem.scheduleDeletion(reply.id, reply.channelId);
        }
        else {
          const embed = new EmbedBuilder()
            .setTitle('⚙️ Hệ thống Auto-Delete')
            .setDescription('Tự động xóa tin nhắn của bot sau 10 giây')
            .setColor(config.colors.delete)
            .addFields(
              { name: '🔧 Lệnh', value: '`!autodelete on` - Bật auto-delete\n`!autodelete off` - Tắt auto-delete\n`!autodelete stats` - Xem thống kê', inline: false }
            )
            .setFooter({ text: 'Mặc định: Bật - Thời gian: 10 giây' });

          const reply = await message.reply({ embeds: [embed] });
          autoDeleteSystem.scheduleDeletion(reply.id, reply.channelId);
        }
      } catch (err) {
        console.error(chalk.red('[AUTODELETE ERROR]'), err);
      }
    })();
  }

  // ===== LỆNH AVATAR =====
  if (command === 'avatar' || command === 'av') {
    (async () => {
      try {
        let targetUser = message.author;
        let size = 1024;

        if (args.length > 0) {
          const firstArg = args[0];
          
          if (!isNaN(firstArg)) {
            size = Math.min(Math.max(parseInt(firstArg), 16), 4096);
            targetUser = message.mentions.users.first() || message.author;
          } 
          else if (message.mentions.users.size > 0) {
            targetUser = message.mentions.users.first();
            if (args[1] && !isNaN(args[1])) {
              size = Math.min(Math.max(parseInt(args[1]), 16), 4096);
            }
          }
          else if (/^\d+$/.test(firstArg)) {
            const user = await avatarSystem.findUserById(message.guild, firstArg);
            if (user) {
              targetUser = user;
              if (args[1] && !isNaN(args[1])) {
                size = Math.min(Math.max(parseInt(args[1]), 16), 4096);
              }
            } else {
              const reply = await message.reply('❌ Không tìm thấy user với ID này!');
              autoDeleteSystem.scheduleDeletion(reply.id, reply.channelId);
              return;
            }
          }
          else {
            const username = args.join(' ');
            const user = await avatarSystem.findUserByUsername(message.guild, username);
            if (user) {
              targetUser = user;
            } else {
              const reply = await message.reply(`❌ Không tìm thấy user "${username}"!`);
              autoDeleteSystem.scheduleDeletion(reply.id, reply.channelId);
              return;
            }
          }
        }

        const avatarURL = await avatarSystem.getUserAvatar(targetUser, size);

        const embed = new EmbedBuilder()
          .setTitle(`🖼️ Avatar của ${targetUser.username}`)
          .setDescription(`**Kích thước:** ${size}x${size}\n**Định dạng:** PNG\n**Tải về:** [Nhấn vào đây](${avatarURL})`)
          .setImage(avatarURL)
          .setColor(config.colors.primary)
          .setFooter({ text: `Yêu cầu bởi ${message.author.tag} • Tự động xóa sau 10s` })
          .setTimestamp();

        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setLabel('📥 Tải Avatar')
              .setStyle(ButtonStyle.Link)
              .setURL(avatarURL),
            new ButtonBuilder()
              .setLabel('⏰ Hủy xóa')
              .setStyle(ButtonStyle.Secondary)
              .setCustomId(`cancel_delete_${message.id}`)
          );

        const reply = await message.reply({ 
          embeds: [embed], 
          components: [row] 
        });
        autoDeleteSystem.scheduleDeletion(reply.id, reply.channelId);

      } catch (err) {
        console.error(chalk.red('[AVATAR ERROR]'), err);
        const errorMsg = await message.reply('❌ Có lỗi khi lấy avatar!');
        autoDeleteSystem.scheduleDeletion(errorMsg.id, errorMsg.channelId);
      }
    })();
  }

  // ===== LỆNH PROFILE =====
  else if (command === 'profile' || command === 'userinfo') {
    (async () => {
      try {
        let targetUser = message.author;
        let targetMember = message.member;

        if (args.length > 0) {
          const firstArg = args[0];
          
          if (message.mentions.users.size > 0) {
            targetUser = message.mentions.users.first();
            targetMember = message.mentions.members.first();
          }
          else if (/^\d+$/.test(firstArg)) {
            const user = await avatarSystem.findUserById(message.guild, firstArg);
            if (user) {
              targetUser = user;
              targetMember = await message.guild.members.fetch(user.id).catch(() => null);
            } else {
              const reply = await message.reply('❌ Không tìm thấy user với ID này!');
              autoDeleteSystem.scheduleDeletion(reply.id, reply.channelId);
              return;
            }
          }
          else {
            const username = args.join(' ');
            const user = await avatarSystem.findUserByUsername(message.guild, username);
            if (user) {
              targetUser = user;
              targetMember = await message.guild.members.fetch(user.id).catch(() => null);
            } else {
              const reply = await message.reply(`❌ Không tìm thấy user "${username}"!`);
              autoDeleteSystem.scheduleDeletion(reply.id, reply.channelId);
              return;
            }
          }
        }

        const profileImage = await avatarSystem.createProfileImage(targetUser, targetMember);
        const attachment = new AttachmentBuilder(profileImage, { name: 'profile.png' });

        const embed = new EmbedBuilder()
          .setTitle(`👤 Thông tin ${targetUser.username}`)
          .setColor(config.colors.profile)
          .setImage('attachment://profile.png')
          .setFooter({ text: `Yêu cầu bởi ${message.author.tag} • Tự động xóa sau 10s` })
          .setTimestamp();

        const userInfo = [
          `**🏷️ Tag:** ${targetUser.tag}`,
          `**🆔 ID:** ${targetUser.id}`,
          `**🤖 Bot:** ${targetUser.bot ? '✅' : '❌'}`,
          `**📅 Tạo tài khoản:** <t:${Math.floor(targetUser.createdTimestamp / 1000)}:R>`,
        ];

        if (targetMember) {
          userInfo.push(
            `**🎭 Nickname:** ${targetMember.nickname || 'Không có'}`,
            `**📥 Tham gia server:** <t:${Math.floor(targetMember.joinedTimestamp / 1000)}:R>`,
            `**🎨 Màu role:** ${targetMember.displayHexColor}`,
            `**👑 Roles:** ${targetMember.roles.cache.size - 1}`
          );
        }

        embed.setDescription(userInfo.join('\n'));

        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setLabel('🖼️ Xem Avatar')
              .setStyle(ButtonStyle.Primary)
              .setCustomId(`view_avatar_${targetUser.id}`),
            new ButtonBuilder()
              .setLabel('🎨 Xem Banner')
              .setStyle(ButtonStyle.Primary)
              .setCustomId(`view_banner_${targetUser.id}`),
            new ButtonBuilder()
              .setLabel('⏰ Hủy xóa')
              .setStyle(ButtonStyle.Secondary)
              .setCustomId(`cancel_delete_${message.id}`)
          );

        const reply = await message.reply({ 
          embeds: [embed], 
          files: [attachment],
          components: [row] 
        });
        autoDeleteSystem.scheduleDeletion(reply.id, reply.channelId);

      } catch (err) {
        console.error(chalk.red('[PROFILE ERROR]'), err);
        const errorMsg = await message.reply('❌ Có lỗi khi lấy thông tin user!');
        autoDeleteSystem.scheduleDeletion(errorMsg.id, errorMsg.channelId);
      }
    })();
  }

  // ===== LỆNH SERVER AVATARS =====
  else if (command === 'serveravatars' || command === 'serverav') {
    (async () => {
      try {
        const limit = parseInt(args[0]) || 12;
        const members = message.guild.members.cache
          .filter(member => !member.user.bot)
          .first(limit);

        if (members.length === 0) {
          const reply = await message.reply('❌ Không tìm thấy thành viên nào!');
          autoDeleteSystem.scheduleDeletion(reply.id, reply.channelId);
          return;
        }

        const users = members.map(member => member.user);
        const collageImage = await avatarSystem.createAvatarCollage(users);
        const attachment = new AttachmentBuilder(collageImage, { name: 'avatars_collage.png' });

        const embed = new EmbedBuilder()
          .setTitle(`🖼️ Avatar Collage - ${message.guild.name}`)
          .setDescription(`Hiển thị ${users.length} thành viên ngẫu nhiên`)
          .setImage('attachment://avatars_collage.png')
          .setColor(config.colors.primary)
          .setFooter({ text: `Yêu cầu bởi ${message.author.tag} • Tự động xóa sau 10s` })
          .setTimestamp();

        const reply = await message.reply({ 
          embeds: [embed], 
          files: [attachment] 
        });
        autoDeleteSystem.scheduleDeletion(reply.id, reply.channelId);

      } catch (err) {
        console.error(chalk.red('[SERVERAVATARS ERROR]'), err);
        const errorMsg = await message.reply('❌ Có lỗi khi tạo avatar collage!');
        autoDeleteSystem.scheduleDeletion(errorMsg.id, errorMsg.channelId);
      }
    })();
  }

  // ===== LỆNH BANNER =====
  else if (command === 'banner') {
    (async () => {
      try {
        let targetUser = message.author;

        if (args.length > 0) {
          const firstArg = args[0];
          
          if (message.mentions.users.size > 0) {
            targetUser = message.mentions.users.first();
          } else if (/^\d+$/.test(firstArg)) {
            const user = await avatarSystem.findUserById(message.guild, firstArg);
            if (user) targetUser = user;
          } else {
            const user = await avatarSystem.findUserByUsername(message.guild, args.join(' '));
            if (user) targetUser = user;
          }
        }

        const fullUser = await client.users.fetch(targetUser.id, { force: true });
        const bannerURL = fullUser.bannerURL({ size: 1024, format: 'png' });

        if (!bannerURL) {
          const reply = await message.reply(`❌ ${targetUser.username} không có banner!`);
          autoDeleteSystem.scheduleDeletion(reply.id, reply.channelId);
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle(`🎨 Banner của ${targetUser.username}`)
          .setDescription(`[Tải banner](${bannerURL})`)
          .setImage(bannerURL)
          .setColor(config.colors.profile)
          .setFooter({ text: `Yêu cầu bởi ${message.author.tag} • Tự động xóa sau 10s` })
          .setTimestamp();

        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setLabel('📥 Tải Banner')
              .setStyle(ButtonStyle.Link)
              .setURL(bannerURL),
            new ButtonBuilder()
              .setLabel('⏰ Hủy xóa')
              .setStyle(ButtonStyle.Secondary)
              .setCustomId(`cancel_delete_${message.id}`)
          );

        const reply = await message.reply({ 
          embeds: [embed], 
          components: [row] 
        });
        autoDeleteSystem.scheduleDeletion(reply.id, reply.channelId);

      } catch (err) {
        console.error(chalk.red('[BANNER ERROR]'), err);
        const errorMsg = await message.reply('❌ Có lỗi khi lấy banner!');
        autoDeleteSystem.scheduleDeletion(errorMsg.id, errorMsg.channelId);
      }
    })();
  }

  // ===== LỆNH PLAY =====
  if (command === 'play' || command === 'p') {
    (async () => {
      try {
        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
          const reply = await message.reply('❌ Bạn cần vào voice channel trước!');
          autoDeleteSystem.scheduleDeletion(reply.id, reply.channelId);
          return;
        }

        const query = args.join(' ');
        if (!query) {
          const reply = await message.reply('❌ Vui lòng nhập tên bài hát hoặc URL YouTube!');
          autoDeleteSystem.scheduleDeletion(reply.id, reply.channelId);
          return;
        }

        const searchMsg = await message.reply('🔍 **Đang tìm kiếm bài hát...**');

        let song;
        
        if (ytdl.validateURL(query)) {
          const songInfo = await ytdl.getInfo(query);
          song = {
            title: songInfo.videoDetails.title,
            url: songInfo.videoDetails.video_url,
            duration: parseInt(songInfo.videoDetails.lengthSeconds),
            thumbnail: songInfo.videoDetails.thumbnails[0]?.url,
            requestedBy: message.author.tag,
            requestedById: message.author.id
          };
        }
        else {
          const results = await musicSystem.searchYouTube(query);
          if (results.length === 0) {
            await searchMsg.edit('❌ Không tìm thấy bài hát nào!');
            autoDeleteSystem.scheduleDeletion(searchMsg.id, searchMsg.channelId, 5000);
            return;
          }
          song = results[0];
          song.requestedBy = message.author.tag;
          song.requestedById = message.author.id;
        }

        if (!song) {
          await searchMsg.edit('❌ Không tìm thấy bài hát!');
          autoDeleteSystem.scheduleDeletion(searchMsg.id, searchMsg.channelId, 5000);
          return;
        }

        if (!musicQueue.get(message.guild.id)) {
          musicQueue.set(message.guild.id, {
            textChannel: message.channel,
            voiceChannel: voiceChannel,
            connection: null,
            songs: [],
            volume: 50,
            playing: false,
            loop: 'none',
            skipVotes: new Set(),
            maxQueueSize: 100
          });
        }

        const queue = musicQueue.get(message.guild.id);

        if (queue.songs.length >= queue.maxQueueSize) {
          await searchMsg.edit('❌ Hàng chờ đã đầy! Không thể thêm bài hát mới.');
          autoDeleteSystem.scheduleDeletion(searchMsg.id, searchMsg.channelId, 5000);
          return;
        }

        queue.songs.push(song);

        const embed = new EmbedBuilder()
          .setTitle('✅ Đã thêm vào hàng chờ')
          .setDescription(`[${song.title}](${song.url})`)
          .addFields(
            { name: '⏱️ Thời lượng', value: musicSystem.formatTime(song.duration), inline: true },
            { name: '📊 Vị trí', value: `#${queue.songs.length}`, inline: true },
            { name: '👤 Yêu cầu bởi', value: message.author.toString(), inline: true }
          )
          .setThumbnail(song.thumbnail || 'https://i.imgur.com/8Q7YQ9e.png')
          .setColor(config.colors.music)
          .setFooter({ text: 'Sử dụng !queue để xem hàng chờ • Tự động xóa sau 10s' });

        await searchMsg.edit({ content: '', embeds: [embed] });
        autoDeleteSystem.scheduleDeletion(searchMsg.id, searchMsg.channelId);

        if (!queue.playing) {
          playMusic(message.guild.id);
        }

      } catch (err) {
        console.error(chalk.red('[PLAY ERROR]'), err);
        const errorMsg = await message.reply('❌ Có lỗi xảy ra khi tìm kiếm bài hát!');
        autoDeleteSystem.scheduleDeletion(errorMsg.id, errorMsg.channelId);
      }
    })();
  }

  // ===== LỆNH HELP =====
  else if (command === 'help') {
    (async () => {
      const embed = new EmbedBuilder()
        .setTitle('🆘 Trợ giúp lệnh Queen Premium Bot')
        .setDescription(`**Prefix:** \`${config.prefix}\`\n⏰ **Auto-Delete:** Tin nhắn tự động xóa sau 10 giây`)
        .setColor(config.colors.primary)
        .addFields(
          { name: '👤 Lệnh Avatar & Profile', value: '`avatar`, `profile`, `serveravatars`, `banner`' },
          { name: '⚙️ Lệnh Auto-Delete', value: '`autodelete on/off/stats`' },
          { name: '🎵 Lệnh Music', value: '`play`, `stop`, `skip`, `queue`, `volume`' },
          { name: '💰 Lệnh Economy', value: '`balance`, `work`, `daily`, `shop`' },
          { name: '🎮 Lệnh Game', value: '`coinflip`, `dice`, `slot`' },
          { name: '🤖 Lệnh AI & Utility', value: '`ai`, `weather`, `translate`, `calc`' }
        )
        .setFooter({ text: 'Tin nhắn tự động xóa sau 10 giây • Sử dụng nút "Hủy xóa" để giữ tin nhắn' });

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setLabel('⏰ Hủy xóa tin nhắn')
            .setStyle(ButtonStyle.Success)
            .setCustomId(`cancel_delete_${message.id}`)
        );

      const reply = await message.reply({ 
        embeds: [embed], 
        components: [row] 
      });
      autoDeleteSystem.scheduleDeletion(reply.id, reply.channelId);
    })();
  }
});

// ===== INTERACTION HANDLERS =====
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  try {
    // Xử lý nút hủy xóa
    if (interaction.customId.startsWith('cancel_delete_')) {
      const messageId = interaction.customId.replace('cancel_delete_', '');
      autoDeleteSystem.cancelDeletion(interaction.message.id);
      
      await interaction.reply({ 
        content: '✅ **Đã hủy tự động xóa tin nhắn này**',
        ephemeral: true 
      });

      // Cập nhật embed để hiển thị đã hủy xóa
      const embed = new EmbedBuilder(interaction.message.embeds[0].data)
        .setFooter({ text: '✅ Đã hủy tự động xóa • Tin nhắn sẽ được giữ lại' });

      await interaction.message.edit({ 
        embeds: [embed],
        components: [] 
      });
    }
    // Xử lý nút xem avatar
    else if (interaction.customId.startsWith('view_avatar_')) {
      const userId = interaction.customId.replace('view_avatar_', '');
      const user = await client.users.fetch(userId);
      const avatarURL = user.displayAvatarURL({ size: 1024 });

      const embed = new EmbedBuilder()
        .setTitle(`🖼️ Avatar của ${user.username}`)
        .setImage(avatarURL)
        .setColor(config.colors.primary);

      await interaction.reply({ 
        embeds: [embed],
        ephemeral: true 
      });
    }
    // Xử lý nút xem banner
    else if (interaction.customId.startsWith('view_banner_')) {
      const userId = interaction.customId.replace('view_banner_', '');
      const user = await client.users.fetch(userId, { force: true });
      const bannerURL = user.bannerURL({ size: 1024 });

      if (!bannerURL) {
        await interaction.reply({ 
          content: '❌ User này không có banner!',
          ephemeral: true 
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(`🎨 Banner của ${user.username}`)
        .setImage(bannerURL)
        .setColor(config.colors.profile);

      await interaction.reply({ 
        embeds: [embed],
        ephemeral: true 
      });
    }
  } catch (error) {
    console.error('Lỗi xử lý interaction:', error);
    await interaction.reply({ 
      content: '❌ Có lỗi xảy ra!',
      ephemeral: true 
    });
  }
});

// ===== CÁC HÀM HỖ TRỢ =====
const db = {
  users: new Collection(),
  guilds: new Collection(),
  economy: new Collection(),
  giveaways: new Collection(),
  tickets: new Collection(),
  warns: new Collection(),
  marriages: new Collection(),
  reminders: new Collection(),
  init: function() {
    console.log(gradient.mind('📊 Đang khởi tạo database ảo...'));
  }
};

db.init();

const cooldowns = new Collection();

// ===== CLIENT EVENTS =====
client.once('ready', () => {
  console.log('\n');
  console.log(boxen(gradient.rainbow(`✅ Queen Premium Bot đã sẵn sàng: ${client.user.tag}`), { 
    padding: 1, 
    margin: 1, 
    borderStyle: 'round' 
  }));
  
  console.log(gradient.pastel(`📊 Bot đang hoạt động trên ${client.guilds.cache.size} server`));
  console.log(gradient.pastel(`👥 Tổng số người dùng: ${client.users.cache.size}`));
  console.log(gradient.pastel(`⏰ Auto-Delete: Bật • Thời gian: 10 giây`));
  console.log(gradient.pastel(`🌐 Dashboard: http://localhost:${PORT}`));
  
  const statuses = [
    { name: `!help trên ${client.guilds.cache.size} server`, type: 0 },
    { name: '👑 Phiên bản Premium 6.0', type: 0 },
    { name: '⏰ Auto-Delete: Bật', type: 0 },
    { name: '!avatar để xem avatar', type: 0 },
    { name: 'Dashboard: /dashboard', type: 0 }
  ];
  
  let currentIndex = 0;
  setInterval(() => {
    client.user.setPresence({
      activities: [statuses[currentIndex]],
      status: 'online'
    });
    currentIndex = (currentIndex + 1) % statuses.length;
  }, 10000);
});

// QR Code Donate
const bank = "MB";
const account = "5211060910";
const name = "NGUYEN MINH QUOC";
const acqId = "970422";
const amount = 0;
const memo = "Ung Ho Queen Premium Bot";

const vietQR = `https://img.vietqr.io/image/${bank}-${account}-${acqId}-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(memo)}&accountName=${encodeURIComponent(name)}`;
const vietQRText = `https://api.vietqr.io/${bank}/${account}/${amount}?memo=${encodeURIComponent(memo)}&accountName=${encodeURIComponent(name)}`;

console.log(chalk.yellow("📷 MÃ QR CODE DONATE MBBANK 📷"));
console.log(chalk.gray("══════════════════════════════════"));
qrcodeTerminal.generate(vietQRText, { small: true });
console.log(chalk.gray("══════════════════════════════════"));
console.log(chalk.cyan("🏦 Ngân hàng:"), chalk.white(bank));
console.log(chalk.cyan("📋 Số tài khoản:"), chalk.white(account));
console.log(chalk.cyan("👤 Chủ tài khoản:"), chalk.white(name));
console.log(chalk.cyan("💵 Số tiền:"), chalk.white(amount === 0 ? "Tùy tâm ❤️" : `${amount.toLocaleString()} VND`));
console.log(chalk.cyan("📝 Nội dung:"), chalk.white(memo));
console.log("\n" + chalk.green("📱 Mở app MBBank/MoMo quét mã QR để Donate"));
console.log(chalk.blue("🌐 Link QR Online:"), chalk.white(vietQR));

QRCode.toFile("mb_qr_premium.png", vietQRText, {
  color: { dark: "#000000", light: "#FFFFFF" }
}, (err) => {
  if (err) console.log(chalk.red("❌ Lỗi khi tạo file QR:"), err);
  else console.log(chalk.green("✅ Đã tạo file QR: mb_qr_premium.png"));
});

// ===== XỬ LÝ LỖI =====
process.on('unhandledRejection', (error) => {
  console.error(chalk.red('❌ Lỗi không xử lý:'), error);
});

process.on('uncaughtException', (error) => {
  console.error(chalk.red('❌ Lỗi exception:'), error);
});

// ===== ĐĂNG NHẬP BOT =====
if (!process.env.DISCORD_TOKEN) {
  console.log(chalk.red('❌ Lỗi: DISCORD_TOKEN chưa được cấu hình trong file .env'));
  console.log(chalk.yellow('📝 Vui lòng thêm DISCORD_TOKEN vào file .env và khởi động lại'));
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch(error => {
  console.log(chalk.red('❌ Lỗi đăng nhập bot:'), error.message);
  console.log(chalk.yellow('🔧 Kiểm tra lại DISCORD_TOKEN trong file .env'));
});