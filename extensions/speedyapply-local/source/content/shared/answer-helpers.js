function jobsLowercaseXPath(expression) {
  return `translate(${expression}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
}
function jobsKeywordXPathPredicate({
  keywords: keywords,
  appearances: appearances,
}) {
  return `(${keywords.map((e) => `contains(${jobsLowercaseXPath(`.`)}, '${e.toLowerCase()}')`).join(` + `)}) >= ${appearances}`;
}
function jobsIgnoredKeywordXPathPredicate({ ignore: ignore }) {
  return ignore && ignore.length
    ? `and not(` +
        ignore
          .map(
            (e) => `contains(${jobsLowercaseXPath(`.`)}, '${e.toLowerCase()}')`,
          )
          .join(` or `) +
        `)`
    : ``;
}

export {
  jobsLowercaseXPath,
  jobsKeywordXPathPredicate,
  jobsIgnoredKeywordXPathPredicate,
};
