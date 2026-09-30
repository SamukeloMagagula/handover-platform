/* api('GET'|'POST', action, paramsOrBody) -> Promise<data>
   Rejects with an Error carrying .message, .status and .data. */
var api = (function () {
  "use strict";

  let csrfToken = null;

  function ensureCsrf() {
    if (csrfToken) return Promise.resolve(csrfToken);
    return raw("GET", "csrf").then(d => (csrfToken = d.csrf_token));
  }

  function handle(resp) {
    return resp.text().then(text => {
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch (e) {
        const err = new Error("The server did not return JSON (HTTP " + resp.status + ").");
        err.status = resp.status;
        throw err;
      }

      if (resp.ok && !data.error) return data;

      // Only the not-signed-in gate sets signedOut, so a refused password on
      // the login page still reaches its caller.
      if (resp.status === 401 && data.signedOut) {
        window.location.replace("login.html");
        return new Promise(() => {});
      }

      const err = new Error(data.error || ("Request failed (status " + resp.status + ")."));
      err.status = resp.status;
      err.data = data;
      throw err;
    });
  }

  function raw(method, action, body) {
    let url = "api.php?action=" + encodeURIComponent(action);
    const opts = { method, cache: "no-store", credentials: "same-origin", headers: {} };

    if (method === "GET") {
      const qs = new URLSearchParams(body || {}).toString();
      if (qs) url += "&" + qs;
    } else {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body || {});
    }

    return fetch(url, opts).then(handle, () => {
      const err = new Error("No connection to the server.");
      err.status = 0;
      throw err;
    });
  }

  function apiFn(method, action, body) {
    if (method === "GET") return raw("GET", action, body);

    return ensureCsrf()
      .then(token => raw("POST", action, Object.assign({}, body, { csrf_token: token })))
      .catch(err => {
        // The session was replaced and the cached token went with it.
        if (err.status === 400 && /form submission/i.test(err.message)) {
          csrfToken = null;
          return ensureCsrf().then(t =>
            raw("POST", action, Object.assign({}, body, { csrf_token: t })));
        }
        throw err;
      });
  }

  apiFn.forgetCsrf = function () { csrfToken = null; };
  return apiFn;
})();
