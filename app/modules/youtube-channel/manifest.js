module.exports = {
  id: 'youtube-channel',
  name: 'YouTube Channel Videos',
  description: "Finds videos on the shelter's YouTube channel that mention a dog by name and links them to that dog's profile, after staff review.",
  version: '1.0.0',
  configSchema: [
    // Deliberately accepts whatever someone pastes -- a channel link, a
    // "@handle", or the raw ID -- and gets resolved to the canonical
    // channel ID server-side on save (see server.js's resolveConfig).
    { key: 'channelId', label: 'YouTube channel link or ID', type: 'text', required: true, placeholder: 'https://www.youtube.com/@yourchannel' }
  ],
  clientAssets: {
    index: ['profile.js'],
    staffPanel: { html: 'staff-panel.html', js: ['staff-panel.js'], css: ['staff-panel.css'] }
  }
};
