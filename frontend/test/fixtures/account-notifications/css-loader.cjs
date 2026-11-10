module.exports = function (source) {
  const names = this.resourcePath.endsWith(".module.css")
    ? Object.fromEntries(
        [...source.matchAll(/^\.([a-zA-Z][\w-]*)/gm)].map((match) => [
          match[1],
          match[1],
        ]),
      )
    : {};
  return `const style=document.createElement('style');style.textContent=${JSON.stringify(source)};document.head.appendChild(style);module.exports=${JSON.stringify(names)};`;
};
