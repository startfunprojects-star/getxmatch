/* Tiny fetch wrapper. All requests are same-origin and send the auth cookie. */
window.api = (function () {
  async function req(method, url, body, isForm) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body != null) {
      if (isForm) {
        opts.body = body; // FormData; browser sets multipart headers
      } else {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (_e) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    get: (u) => req('GET', u),
    post: (u, b) => req('POST', u, b),
    put: (u, b) => req('PUT', u, b),
    del: (u) => req('DELETE', u),
    postForm: (u, fd) => req('POST', u, fd, true),
    putForm: (u, fd) => req('PUT', u, fd, true),
  };
})();
