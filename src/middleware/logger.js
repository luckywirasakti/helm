module.exports = (method, url, status, ms) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`  ${ts} ${method} ${url} ${status} ${ms}ms`);
};
