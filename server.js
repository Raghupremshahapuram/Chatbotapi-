require('dotenv').config(); 

const express = require('express');
const { Pool } = require('pg');
const OpenAI = require('openai');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();

// ✅ CORS: Allow both local and Netlify frontend
app.use(cors({
  origin: ['http://localhost:3000', 'https://fbooking.netlify.app'],
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(bodyParser.json());

// ✅ PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ✅ OpenRouter Chatbot Setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    // Optional: Remove if OpenRouter doesn't require referer
    'HTTP-Referer': 'https://fbooking.netlify.app/',
    'X-Title': 'Local Booking Assistant',
  },
});
app.post('/chatbot', async (req, res) => {
  const { messages } = req.body;

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid message format' });
  }

  try {
    const systemMessage = {
      role: 'system',
      content: `
You are a smart assistant for a movie and event booking platform.

You can:
- Book movie tickets (needs: movie name, date, time, number of seats)
- Show list of available movies
- Show list of upcoming events
- Show showtimes for a specific movie

When booking, return:
{
  "movie_name": "Dasara",
  "date": "today",
  "time": "4 PM",
  "seats": 2
}

When asked for listings or showtimes, return:
{
  "action": "list_movies" | "list_events" | "get_timings",
  "movie_name": "RRR" (optional),
  "date": "today" (optional)
}

Do not use code blocks or markdown. Output JSON inline.
`.trim(),
    };

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [systemMessage, ...messages],
      max_tokens: 300,
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() || '';
    console.log('🧠 Raw response from OpenAI:\n', raw);

    let reply = raw;
    let bookingIntent = null;
    let action = null;

    const jsonMatch = raw.match(/{[\s\S]*?}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);

        // 🟦 Check for booking intent
        if (parsed.movie_name && parsed.date && parsed.time && parsed.seats) {
          bookingIntent = {
            movie_name: parsed.movie_name,
            date: parsed.date.toLowerCase(),
            time: parsed.time,
            seats: Number(parsed.seats),
          };
        }

        // 🟦 Check for action (movie list / event list / showtimes)
        else if (parsed.action) {
          action = parsed;

          // Handle action inline
          if (action.action === 'list_movies') {
            const result = await pool.query('SELECT name FROM latest_movies');
            const movieNames = result.rows.map(m => `🎬 ${m.name}`).join('\n');
            return res.json({ reply: `Here are the available movies:\n\n${movieNames}` });
          }

          if (action.action === 'list_events') {
            const result = await pool.query('SELECT name, event_date FROM events ORDER BY event_date');
            const events = result.rows.map(e => `🎭 ${e.name} on ${e.event_date.toISOString().split('T')[0]}`).join('\n');
            return res.json({ reply: `Here are the upcoming events:\n\n${events}` });
          }

          // For `get_timings`, let frontend handle showing available time buttons
        }

        reply = raw.replace(jsonMatch[0], '').trim();
      } catch (e) {
        console.warn('⚠️ JSON parsing failed:', e.message);
      }
    }

    res.json({ reply, bookingIntent, action });
  } catch (err) {
    console.error('❌ Chatbot error:', err.message);
    res.status(500).json({ error: 'Chatbot service failed' });
  }
});

// Fetch all latest movies
app.get('/latest-movies', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM latest_movies');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch all upcoming movies
app.get('/upcoming-movies', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM upcoming_movies ORDER BY release_date ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch all events
app.get('/events', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM events');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch all users
app.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new user
app.post('/users', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING *',
      [name, email, password]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Fetch filtered bookings
app.get('/bookings', async (req, res) => {
  const { movie_name, date, time } = req.query;

  try {
    let query = 'SELECT * FROM bookings WHERE status = $1';
    const params = ['active'];
    let index = 2;

    if (movie_name) {
      query += ` AND movie_name = $${index++}`;
      params.push(movie_name);
    }

    if (date) {
      query += ` AND date = $${index++}`;
      params.push(date);
    }

    if (time) {
      query += ` AND time = $${index++}`;
      params.push(time);
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new booking
app.post('/bookings', async (req, res) => {
  const { movie_name, event_name, time, date, seats } = req.body;

  if (!movie_name || !time || !date || !Array.isArray(seats)) {
    return res.status(400).json({ error: 'Missing or invalid booking data' });
  }

  try {
    const result = await pool.query(
      `SELECT seats FROM bookings
       WHERE movie_name = $1 AND date = $2 AND time = $3 AND status = 'active'`,
      [movie_name, date, time]
    );

    const alreadyBooked = new Set();
    for (const row of result.rows) {
      const seatArray = JSON.parse(row.seats || '[]');
      seatArray.forEach(seat => alreadyBooked.add(seat));
    }

    const conflicts = seats.filter(seat => alreadyBooked.has(seat));
    if (conflicts.length > 0) {
      return res.status(409).json({
        error: `❌ These seats are already booked: ${conflicts.join(', ')}`,
      });
    }

    const insert = await pool.query(
      `INSERT INTO bookings (movie_name, event_name, time, date, seats, status)
       VALUES ($1, $2, $3, $4, $5, 'active') RETURNING *`,
      [movie_name, event_name, time, date, JSON.stringify(seats)]
    );

    res.status(201).json(insert.rows[0]);

  } catch (err) {
    console.error('❌ Booking error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Get already booked seats (active only)
app.get('/booked-seats', async (req, res) => {
  const { movie, date, time } = req.query;

  if (!movie || !date || !time) {
    return res.status(400).json({ error: 'Missing movie, date, or time' });
  }

  try {
    const result = await pool.query(
      `SELECT seats FROM bookings
       WHERE movie_name = $1 AND date = $2 AND time = $3 AND status = 'active'`,
      [movie, date, time]
    );

    const bookedSeats = result.rows.flatMap(row => JSON.parse(row.seats || '[]'));
    res.json({ bookedSeats });
  } catch (err) {
    console.error('❌ Failed to fetch booked seats:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Fetch all cancelled bookings
app.get('/cancelled-bookings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cancelled_bookings');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a booking
app.post('/cancelled-bookings', async (req, res) => {
  const { booking_id, reason } = req.body;
  try {
    const cancelResult = await pool.query(
      'INSERT INTO cancelled_bookings (booking_id, reason) VALUES ($1, $2) RETURNING *',
      [booking_id, reason]
    );
    await pool.query(
      'UPDATE bookings SET status = $1 WHERE id = $2',
      ['cancelled', booking_id]
    );
    res.status(201).json(cancelResult.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Start Server ---
app.listen(process.env.PORT, () => {
  console.log(`✅ Server running on http://localhost:${process.env.PORT}`);
});
