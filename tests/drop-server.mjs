// A provider on this computer that redirects /movie/1.mkv to /stream/1.mkv, answers
// ranges, and stops its first answer partway (the socket closed after 2 MB), as providers
// do with a connection they think is idle. For tests/source.test.ts.
import http from "node:http";

export async function startDroppingServer(size, byteAt) {
  const ranges = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/movie/1.mkv") {
      res.writeHead(302, { Location: "/stream/1.mkv?token=t" });
      res.end();
      return;
    }
    const start = Number((/bytes=(\d+)-/.exec(req.headers.range || "") || [0, 0])[1]);
    ranges.push(req.headers.range || "");
    res.writeHead(206, { "Content-Range": `bytes ${start}-${size - 1}/${size}`, "Content-Length": size - start });
    const bytes = new Uint8Array(size - start);
    for (let i = 0; i < bytes.length; i++) bytes[i] = byteAt(start + i);
    if (ranges.length === 1) {
      res.write(bytes.subarray(0, 2 * 1024 * 1024));
      setTimeout(() => res.socket && res.socket.destroy(), 50);
    } else res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/movie/1.mkv`,
    ranges,
    close: () => server.close(),
  };
}
