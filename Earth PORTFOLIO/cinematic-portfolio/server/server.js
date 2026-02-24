const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs/promises');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Security Headers
app.use(helmet({
    contentSecurityPolicy: false, // Adjusted for local dev / direct canvas usage
}));

// Global Compression with WebP exclusion to prevent double-compressing
app.use(compression({
    filter: (req, res) => {
        if (req.headers['x-no-compression']) {
            return false;
        }
        // Don't double-compress WebP images
        const contentType = res.getHeader('Content-Type');
        if (contentType && contentType.includes('image/webp')) {
            return false;
        }
        return compression.filter(req, res);
    }
}));

app.use(cors());

// Static Routes - Sequence (Aggressive Cache)
const sequencePath = path.join(__dirname, '../public/assets/me');
app.use('/assets/me', express.static(sequencePath, {
    maxAge: '1y',
    immutable: true,
}));

// Static Routes - Other Public Assets (Standard Cache)
const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath, {
    maxAge: 0 // Disabled for development, bust cache so script.js updates work!
}));

// Dynamic Frame Manifest API
app.get('/api/frames', async (req, res) => {
    try {
        const variant = req.query.variant || 'desktop';

        // Ensure directory exists, or it throws error
        await fs.mkdir(sequencePath, { recursive: true });
        const files = await fs.readdir(sequencePath);

        let frames = files
            .filter(f => f.match(/\.webp$/i))
            // Robust numeric sort to guarantee sequential parsing (e.g. frame_1.webp, frame_10.webp)
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
            .map(f => `/assets/me/${f}`);

        // Mobile fallback truncates frames heavily to preserve memory & thermal limits
        if (variant === 'mobile') {
            frames = frames.filter((_, index) => index % 2 === 0);
            if (frames.length > 60) frames = frames.slice(0, 60);
        }

        res.json({
            totalFrames: frames.length,
            batchSize: variant === 'mobile' ? 5 : 10,
            frames: frames,
            fallbackStrategy: frames.length === 0 ? 'procedural' : 'none'
        });
    } catch (e) {
        console.error("Frame manifest error:", e);
        res.status(500).json({ error: "Failed to load manifest", fallbackStrategy: 'procedural' });
    }
});

// Fallback to index.html for undefined routes (SPA behavior if needed)
app.get('*', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Cinematic Portfolio Engine running perfectly on http://localhost:${PORT}`);
    console.log(`👉 Asset serving optimized. Compression enabled.`);
});
