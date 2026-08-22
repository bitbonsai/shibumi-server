const root = document.documentElement;
const themeMeta = document.querySelector('meta[name="theme-color"]');
function syncThemeMeta() {
  const theme = root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  themeMeta?.setAttribute("content", theme === "dark" ? "#1b130f" : "#f5f0e4");
}
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function typingDelay() {
  return 55 + (Math.random() * 30 - 15);
}

function railTo(terminal, row) {
  const output = terminal.querySelector(".clack-output");
  const rail = output?.querySelector(".clack-rail");
  const glyph = row?.querySelector(".clack-glyph");
  if (!output || !rail || !glyph) return;
  rail.style.height = `${row.offsetTop + glyph.getBoundingClientRect().height / 2 - parseFloat(getComputedStyle(rail).top)}px`;
}

function animateTerminal() {
  const terminal = document.querySelector("[data-server-cli]");
  const typed = terminal?.querySelector("[data-server-typed]");
  const cursor = terminal?.querySelector("[data-server-cursor]");
  const steps = terminal?.querySelectorAll(".deploy-step");
  const replay = terminal?.querySelector(".terminal-replay");
  if (!terminal || !typed || !cursor || !steps?.length) return;

  const command = "bun ship";
  let generation = 0;

  function run(delay = 0) {
    const current = ++generation;
    typed.textContent = "";
    cursor.classList.remove("done");
    replay?.classList.remove("is-ready");
    steps.forEach((step) => step.classList.remove("visible", "complete"));
    const rail = terminal.querySelector(".clack-rail");
    if (rail) rail.style.height = "0px";

    if (reducedMotion) {
      typed.textContent = command;
      cursor.classList.add("done");
      steps.forEach((step) => step.classList.add("visible", "complete"));
      railTo(terminal, steps[steps.length - 1]);
      return;
    }

    terminal.classList.add("is-animated");
    function reveal(index) {
      if (current !== generation || index >= steps.length) return;
      const row = steps[index];
      row.classList.add("visible");
      railTo(terminal, row);
      setTimeout(() => {
        if (current !== generation) return;
        row.classList.add("complete");
        if (index === steps.length - 1) replay?.classList.add("is-ready");
        else setTimeout(() => reveal(index + 1), 200);
      }, 300);
    }
    function type(index) {
      if (current !== generation) return;
      if (index < command.length) {
        typed.textContent += command[index];
        setTimeout(() => type(index + 1), typingDelay());
      } else {
        cursor.classList.add("done");
        setTimeout(() => reveal(0), 350);
      }
    }
    setTimeout(() => type(0), delay);
  }

  replay?.addEventListener("click", () => {
    replay.classList.remove("is-spinning");
    void replay.offsetWidth;
    replay.classList.add("is-spinning");
    run(80);
  });
  addEventListener("resize", () => {
    const visible = [...steps].filter((step) => step.classList.contains("visible"));
    if (visible.length) railTo(terminal, visible[visible.length - 1]);
  });
  run(600);
}

animateTerminal();

function animateLoopTerminal() {
  const terminal = document.querySelector("[data-setup-cli]");
  const typed = terminal?.querySelector("[data-setup-typed]");
  const cursor = terminal?.querySelector("[data-setup-cursor]");
  const scenes = terminal ? [...terminal.querySelectorAll(".clack-scene")] : [];
  const tabs = terminal ? [...terminal.querySelectorAll("[data-scene-tab]")] : [];
  if (!terminal || !typed || !cursor || scenes.length === 0) return;

  const command = "bun ship";
  let generation = 0;

  function railToLocal(scene, row) {
    const rail = scene.querySelector(".clack-rail");
    const glyph = row?.querySelector(".clack-glyph");
    if (!rail || !glyph) return;
    rail.style.height = `${row.offsetTop + glyph.getBoundingClientRect().height / 2 - parseFloat(getComputedStyle(rail).top)}px`;
  }

  function showScene(name) {
    const current = ++generation;
    const scene = scenes.find((candidate) => candidate.dataset.scene === name) ?? scenes[0];
    scenes.forEach((candidate) => { candidate.hidden = candidate !== scene; });
    tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.sceneTab === scene.dataset.scene));
    const steps = [...scene.querySelectorAll(".clack-row")];

    if (reducedMotion) {
      typed.textContent = command;
      cursor.classList.add("done");
      steps.forEach((step) => step.classList.add("visible", "complete"));
      railToLocal(scene, steps[steps.length - 1]);
      return;
    }

    terminal.classList.add("is-animated");
    steps.forEach((step) => step.classList.remove("visible", "complete"));
    const rail = scene.querySelector(".clack-rail");
    if (rail) rail.style.height = "0px";
    typed.textContent = "";
    cursor.classList.remove("done");

    function reveal(index) {
      if (current !== generation || index >= steps.length) return;
      const row = steps[index];
      row.classList.add("visible");
      railToLocal(scene, row);
      setTimeout(() => {
        if (current !== generation) return;
        row.classList.add("complete");
        setTimeout(() => reveal(index + 1), 260);
      }, 340);
    }
    function type(index) {
      if (current !== generation) return;
      if (index < command.length) {
        typed.textContent += command[index];
        setTimeout(() => type(index + 1), typingDelay());
      } else {
        cursor.classList.add("done");
        setTimeout(() => reveal(0), 400);
      }
    }
    setTimeout(() => type(0), 150);
  }

  tabs.forEach((tab) => tab.addEventListener("click", () => showScene(tab.dataset.sceneTab)));
  addEventListener("resize", () => {
    const scene = scenes.find((candidate) => !candidate.hidden);
    const visible = scene ? [...scene.querySelectorAll(".clack-row.visible")] : [];
    if (scene && visible.length) railToLocal(scene, visible[visible.length - 1]);
  });
  showScene("setup");
}

animateLoopTerminal();

document.querySelector(".theme-toggle")?.addEventListener("click", () => {
  const current = root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  root.dataset.theme = current === "dark" ? "light" : "dark";
  syncThemeMeta();
  try { localStorage.setItem("shibumi-theme", root.dataset.theme); } catch {}
});

const stackMenus = [...document.querySelectorAll(".stack-menu")].filter((menu) => menu instanceof HTMLDetailsElement);
document.addEventListener("click", (event) => {
  for (const menu of stackMenus) if (!menu.contains(event.target)) menu.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const menu = stackMenus.find((candidate) => candidate.open);
  if (!menu) return;
  menu.open = false;
  menu.querySelector("summary")?.focus();
});

for (const copyButton of document.querySelectorAll("[data-copy]")) copyButton.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement)) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copy ?? "");
    button.classList.add("is-copied");
    button.setAttribute("aria-label", "Install command copied");
    setTimeout(() => {
      button.classList.remove("is-copied");
      button.setAttribute("aria-label", "Copy install command");
    }, 1_500);
  } catch {
    button.setAttribute("aria-label", "Could not copy install command");
  }
});

syncThemeMeta();
