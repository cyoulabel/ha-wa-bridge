const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3000');

ws.on('open', function open() {
  console.log('Connected to HA WhatsApp Bridge');
});

ws.on('message', function message(data) {
  const msg = JSON.parse(data);
  console.log('Received:', msg);

  if (msg.type === 'status' && msg.status === 'ready') {
      console.log('Bridge is ready, sending poll...');
      
      const pollCommand = {
          type: 'send_poll',
          number: '1234567890', // REPLACE WITH REAL NUMBER OR GROUP NAME
          // group_name: 'My Group', // OR USE GROUP NAME
          message: 'What is your favorite color?',
          options: ['Red', 'Blue', 'Green'],
          allow_multiple_answers: true
      };

      ws.send(JSON.stringify(pollCommand));
      console.log('Poll command sent:', pollCommand);
      
      // Close after a short delay
      setTimeout(() => {
          ws.close();
          process.exit(0);
      }, 2000);
  }
});

ws.on('error', function error(err) {
    console.error('WebSocket error:', err);
});
