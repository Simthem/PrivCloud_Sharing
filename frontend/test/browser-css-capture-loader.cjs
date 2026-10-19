const chunks = [];

function captureCss(source) {
  chunks.push(source);
  return "export default {};";
}

captureCss.takeCss = () => {
  const css = chunks.join("\n");
  chunks.length = 0;
  return css;
};

module.exports = captureCss;
