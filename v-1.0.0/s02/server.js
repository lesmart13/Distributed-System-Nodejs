const express = require('express');
const axios = require('axios');
const multer = require('multer');
const app = express();

// Configuration
const SERVER_PORT = process.argv[2] || 3000;
const OTHER_SERVERS = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002'
].filter(url => !url.includes(`:${SERVER_PORT}`));

// Multer setup for file uploads (in-memory storage)
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// State
let isLeader = false;
let messages = [];
let term = 0;
let lastLogIndex = -1;
let leaderUrl = null;

// Leader election timeout
let electionTimeout = null;
function resetElectionTimeout() {
    if (electionTimeout) clearTimeout(electionTimeout);
    electionTimeout = setTimeout(startElection, Math.random() * 150 + 150);
}

// Become leader and start heartbeat
async function becomeLeader() {
    isLeader = true;
    term++;
    leaderUrl = `http://localhost:${SERVER_PORT}`;
    console.log(`Server ${SERVER_PORT} became leader for term ${term}`);
    resetElectionTimeout();
    sendHeartbeats();
}

// Start election
async function startElection() {
    if (isLeader) return;
    term++;
    let votes = 1;
    
    try {
        const responses = await Promise.all(
            OTHER_SERVERS.map(url => 
                axios.post(`${url}/vote`, { term, lastLogIndex })
                    .catch(() => ({ data: { voteGranted: false } }))
            )
        );
        
        votes += responses.filter(r => r.data.voteGranted).length;
        
        if (votes > Math.floor((OTHER_SERVERS.length + 1) / 2)) {
            becomeLeader();
        } else {
            resetElectionTimeout();
        }
    } catch (error) {
        console.error(`Election failed: ${error.message}`);
        resetElectionTimeout();
    }
}

// Handle vote requests
app.post('/vote', (req, res) => {
    const { term: candidateTerm, lastLogIndex: candidateIndex } = req.body;
    
    if (candidateTerm > term && candidateIndex >= lastLogIndex) {
        term = candidateTerm;
        isLeader = false;
        resetElectionTimeout();
        res.json({ voteGranted: true });
    } else {
        res.json({ voteGranted: false });
    }
});

// Send heartbeats and replicate logs
async function sendHeartbeats() {
    if (!isLeader) return;
    
    try {
        const responses = await Promise.all(
            OTHER_SERVERS.map(url => 
                axios.post(`${url}/append`, {
                    term,
                    leaderId: SERVER_PORT,
                    entries: messages,
                    lastLogIndex
                }).catch(() => ({ data: { success: false } }))
            )
        );
        
        if (responses.some(r => !r.data.success)) {
            console.log(`Some followers rejected append at term ${term}`);
        }
    } catch (error) {
        console.error(`Heartbeat failed: ${error.message}`);
    }
    
    setTimeout(sendHeartbeats, 100);
}

// Handle log replication
app.post('/append', (req, res) => {
    const { term: leaderTerm, entries, lastLogIndex: leaderIndex, leaderId } = req.body;
    
    if (leaderTerm >= term) {
        term = leaderTerm;
        isLeader = false;
        messages = entries.slice(); // Deep copy
        lastLogIndex = leaderIndex;
        leaderUrl = `http://localhost:${leaderId}`;
        resetElectionTimeout();
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

// Client message submission with file
app.post('/message', upload.single('file'), async (req, res) => {
    const { content } = req.body;
    
    if (!isLeader) {
        return res.status(307).json({ 
            error: 'Not leader', 
            redirect: leaderUrl || OTHER_SERVERS[0] 
        });
    }
    
    const newMessage = {
        id: lastLogIndex + 1,
        content,
        timestamp: new Date().toISOString(),
        file: req.file ? {
            name: req.file.originalname,
            data: req.file.buffer.toString('base64'),
            mimeType: req.file.mimetype
        } : null
    };
    messages.push(newMessage);
    lastLogIndex++;
    
    try {
        const responses = await Promise.all(
            OTHER_SERVERS.map(url => 
                axios.post(`${url}/append`, {
                    term,
                    leaderId: SERVER_PORT,
                    entries: messages,
                    lastLogIndex
                }, { timeout: 500 })
                    .catch(() => ({ data: { success: false } }))
            )
        );
        
        const successful = responses.filter(r => r.data.success).length;
        if (successful >= Math.floor(OTHER_SERVERS.length / 2)) {
            res.json({ success: true, message: newMessage });
        } else {
            res.status(500).json({ error: 'Failed to reach consensus' });
        }
    } catch (error) {
        res.status(500).json({ error: ` Ascyncronous error: ${error.message}` });
    }
});

// Get all messages
app.get('/messages', (req, res) => {
    res.json({
        messages,
        isLeader,
        port: SERVER_PORT,
        term,
        leaderUrl
    });
});

// Start server
app.listen(SERVER_PORT, () => {
    console.log(`Server running on port ${SERVER_PORT}`);
    resetElectionTimeout();
});