(function () {
  "use strict";

  var form     = document.getElementById("form-forgot");
  var errorBox = document.getElementById("auth-error");
  var notice   = document.getElementById("auth-notice");
  var button   = form.querySelector("button[type=submit]");

  button.dataset.label = button.textContent;

  function busy(on, label) {
    button.disabled = on;
    button.textContent = on ? label : button.dataset.label;
  }

  /* Sent straight back to signing in when the feature is off, rather than
     being shown a form whose only possible outcome is a refusal. */
  api("GET", "me").then(function (res) {
    if (res.authenticated) {
      window.location.replace("app.html");
      return;
    }
    if (res.installed === false) {
      window.location.replace("install.html");
      return;
    }
    if (!res.reset) {
      window.location.replace("login.html");
    }
  }).catch(function () {
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errorBox.hidden = true;
    busy(true, "Sending…");

    api("POST", "forgot", { email: new FormData(form).get("email") })
      .then(function (res) {
        /* The same words whether or not that address has an account. The form
           is a way to ask for a link, not a way to find out who has one. */
        notice.textContent = res.message ||
          "If that address has an account, a reset link is on its way.";
        notice.hidden = false;
        form.hidden = true;
      })
      .catch(function (err) {
        busy(false);
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      });
  });
})();
