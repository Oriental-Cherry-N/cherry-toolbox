// This entry point must not import compiled application modules or rebuild files.
const { app } = require('electron');
app.setName('Cherry Toolbox');
const ownsInstance = app.requestSingleInstanceLock({ sourceProbe: true, focus: !process.argv.includes('--quiet') });
// Exit 42 means that no application owns the profile; 0 means it received the focus request.
app.exit(ownsInstance ? 42 : 0);
