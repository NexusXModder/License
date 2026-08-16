const express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "secure_default_pass";

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'keys.json');

// Helper: Read Keys
const readKeys = () => {
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify([]));
    }
    try {
        const data = fs.readFileSync(DATA_FILE);
        return JSON.parse(data);
    } catch (err) {
        return [];
    }
};

// Helper: Write Keys
const writeKeys = (keys) => {
    fs.writeFileSync(DATA_FILE, JSON.stringify(keys, null, 2));
};

// --- Admin Authentication API ---
app.post('/api/admin-login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true, message: 'Authentication Granted' });
    } else {
        res.status(401).json({ success: false, message: 'Invalid Credentials' });
    }
});

// --- Generate License Key API ---
app.post('/api/generate', (req, res) => {
    let { name, durationDays, password } = req.body;
    
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, message: 'Unauthorized Access' });
    }
    
    const keys = readKeys();
    const keyName = name ? name.toUpperCase().replace(/\s+/g, '_') : 'PRO';
    const licenseKey = `${keyName}-${Math.random().toString(36).substring(2, 8).toUpperCase()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    const createdAt = new Date();
    const expiresAt = new Date();
    expiresAt.setDate(createdAt.getDate() + parseInt(durationDays || 30));

    const newKey = {
        id: Date.now().toString(),
        key: licenseKey,
        name: name || 'Standard Client',
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        status: 'active'
    };

    keys.unshift(newKey);
    writeKeys(keys);

    res.json({ success: true, message: 'Key Generated Successfully', data: newKey });
});

// --- Fetch All Keys API ---
app.post('/api/keys', (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    res.json(readKeys());
});

// --- Delete Key API ---
app.delete('/api/key/:id', (req, res) => {
    let keys = readKeys();
    keys = keys.filter(k => k.id !== req.params.id);
    writeKeys(keys);
    res.json({ success: true, message: 'Key Revoked Successfully' });
});

// --- Client App Verification API ---
app.post('/api/verify', (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).json({ success: false, message: 'License key is missing' });

    const keys = readKeys();
    const foundKey = keys.find(k => k.key === key);

    if (!foundKey) return res.status(404).json({ success: false, message: 'Invalid License Key' });
    if (foundKey.status !== 'active') return res.status(403).json({ success: false, message: 'License Key is Suspended' });

    if (new Date() > new Date(foundKey.expiresAt)) {
        return res.status(403).json({ success: false, message: 'License Key has Expired' });
    }

    res.json({ 
        success: true, 
        message: 'Authentication Successful', 
        name: foundKey.name,
        expiresAt: foundKey.expiresAt 
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
