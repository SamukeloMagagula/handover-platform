(function () {
  "use strict";

  var form     = document.getElementById("install-form");
  var go       = document.getElementById("go");
  var errorBox = document.getElementById("error");
  var done     = document.getElementById("done");

  function show(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  api("GET", "me").then(function (res) {
    if (res.authenticated || res.installed) {
      window.location.replace("login.html");
    }
  }).catch(function (err) {
    show(err.message);
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errorBox.hidden = true;
    go.disabled = true;

    api("POST", "install", {
      name:     document.getElementById("name").value,
      email:    document.getElementById("email").value,
      password: document.getElementById("password").value,
      confirm:  document.getElementById("confirm").value
    }).then(function () {
      form.hidden = true;
      done.hidden = false;
    }).catch(function (err) {
      go.disabled = false;
      show(err.message);
    });
  });

  var pw      = document.getElementById("password");
  var confirm = document.getElementById("confirm");
  var reqList = document.getElementById("pw-reqs");
  var match   = document.getElementById("pw-match");

  var rules = {
    len:     function (v) { return v.length >= 10; },
    upper:   function (v) { return /[A-Z]/.test(v); },
    lower:   function (v) { return /[a-z]/.test(v); },
    number:  function (v) { return /[0-9]/.test(v); },
    special: function (v) { return /[^A-Za-z0-9]/.test(v); }
  };

  function refreshMatch() {
    if (!confirm.value) {
      match.hidden = true;
      return;
    }
    var same = pw.value === confirm.value;
    match.hidden = false;
    match.textContent = same ? "Passwords match" : "Passwords do not match";
    match.classList.toggle("ok", same);
    match.classList.toggle("bad", !same);
  }

  pw.addEventListener("input", function () {
    reqList.querySelectorAll("li").forEach(function (li) {
      li.classList.toggle("ok", rules[li.dataset.req](pw.value));
    });
    refreshMatch();
  });
  confirm.addEventListener("input", refreshMatch);
})();
