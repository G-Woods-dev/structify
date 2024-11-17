const path = require('path');

function serveRegister(req, res) {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
}

function serveLogin(req, res) {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
}

function serveIndex(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
}

function serveSlash(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
}


module.exports = { serveRegister, serveLogin, serveIndex, serveSlash};

