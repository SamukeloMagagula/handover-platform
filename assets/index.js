(function () {
  "use strict";

  api("GET", "me").then(function (res) {
    if (res.authenticated) {
      window.location.replace("app.html");
      return;
    }
    window.location.replace(res.installed === false ? "install.html" : "login.html");
  }).catch(function () {
    window.location.replace("login.html");
  });
})();
