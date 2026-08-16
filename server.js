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

const writeKeys = (keys) => {
    fs.writeFileSync(DATA_FILE, JSON.stringify(keys, null, 2));
};

// --- Admin Authentication ---
app.post('/api/admin-login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true, message: 'Authentication Granted' });
    } else {
        res.status(401).json({ success: false, message: 'Invalid Credentials' });
    }
});

// --- Generate Key with Device Limit ---
app.post('/api/generate', (req, res) => {
    let { name, durationDays, maxDevices, password } = req.body;
    
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
        maxDevices: parseInt(maxDevices || 1), // ডিফল্ট ১টি ডিভাইস
        devices: [], // কোন কোন ডিভাইস লগইন করেছে তাদের আইডি এখানে জমাবে
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        status: 'active'
    };

    keys.unshift(newKey);
    writeKeys(keys);

    res.json({ success: true, message: 'Key Generated Successfully', data: newKey });
});

// --- Fetch All Keys ---
app.post('/api/keys', (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    res.json(readKeys());
});

// --- Delete/Revoke Key ---
app.delete('/api/key/:id', (req, res) => {
    let keys = readKeys();
    keys = keys.filter(k => k.id !== req.params.id);
    writeKeys(keys);
    res.json({ success: true, message: 'Key Revoked Successfully' });
});

// --- Client Verify & Device Binding API ---
app.post('/api/verify', (req, res) => {
    const { key, deviceId } = req.body;
    
    if (!key || !deviceId) {
        return res.status(400).json({ success: false, message: 'License key and Device ID are required' });
    }

    const keys = readKeys();
    const foundKey = keys.find(k => k.key === key);

    if (!foundKey) return res.status(404).json({ success: false, message: 'Invalid License Key' });
    if (foundKey.status !== 'active') return res.status(403).json({ success: false, message: 'License Key is Suspended' });

    // Expiry Check
    if (new Date() > new Date(foundKey.expiresAt)) {
        return res.status(403).json({ success: false, message: 'License Key has Expired' });
    }

    // Device Limit Logic
    const isDeviceAlreadyRegistered = foundKey.devices.includes(deviceId);

    if (!isDeviceAlreadyRegistered) {
        if (foundKey.devices.length >= foundKey.maxDevices) {
            return res.status(403).json({ 
                success: false, 
                message: `Device limit exceeded! This key is already registered on ${foundKey.maxDevices} device(s).` 
            });
        }
        // নতুন ডিভাইস হলে রেজিস্টার্ড ডিভাইসের লিস্টে যুক্ত করে সেভ করে দেবো
        foundKey.devices.push(deviceId);
        writeKeys(keys);
    }

    res.json({ 
        success: true, 
        message: 'Authentication Successful', 
        name: foundKey.name,
        boundDevices: foundKey.devices.length,
        maxDevices: foundKey.maxDevices,
        expiresAt: foundKey.expiresAt 
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
