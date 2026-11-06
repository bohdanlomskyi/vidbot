// Preloaded into the setup wizard by its integration test. It answers the two Discord REST
// calls the wizard makes with fixed data and passes every other request through.
const realFetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  const authorized =
    request.headers.get('authorization') === `Bot ${process.env.FAKE_DISCORD_TOKEN}`;
  if (request.url === 'https://discord.com/api/v10/applications/@me') {
    return Promise.resolve(
      authorized
        ? Response.json({ id: '123456789012345678', name: 'Test Bot' })
        : new Response('{}', { status: 401 }),
    );
  }
  if (request.url === 'https://discord.com/api/v10/users/@me/guilds') {
    return Promise.resolve(Response.json([{ id: '234567890123456789', name: 'Home' }]));
  }
  return realFetch(input, init);
};
