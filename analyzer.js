const babelParser = require("@babel/parser");
const babelTraverse = require("@babel/traverse").default;
const { join } = require("path");
const fs = require("fs");
const path = require("path");

const IGNORE_DIRS = ["node_modules", "venv", "docs", "test", "e2e", "examples"];

const getAllFiles = (dir, extn, files, result, regex) => {
  files = files || fs.readdirSync(dir);
  result = result || [];
  regex = regex || new RegExp(`\\${extn}$`);

  for (let i = 0; i < files.length; i++) {
    let file = join(dir, files[i]);
    if (fs.statSync(file).isDirectory()) {
      // Ignore directories
      const dirName = path.basename(file);
      if (
        dirName.startsWith(".") ||
        IGNORE_DIRS.includes(dirName.toLowerCase())
      ) {
        continue;
      }
      try {
        result = getAllFiles(file, extn, fs.readdirSync(file), result, regex);
      } catch (error) {
        continue;
      }
    } else {
      if (regex.test(file)) {
        result.push(file);
      }
    }
  }
  return result;
};

const babelParserOptions = {
  sourceType: "module",
  plugins: [
    "optionalChaining",
    "classProperties",
    "decorators-legacy",
    "exportDefaultFrom",
    "doExpressions",
    "numericSeparator",
    "dynamicImport",
    "jsx",
    "typescript",
  ],
};

/**
 * Filter only references to (t|jsx?) or (less|scss) files for now.
 * Opt to use our relative paths.
 */
const setFileRef = (allImports, file, pathway) => {
  // remove unexpected extension imports
  if (/\.(svg|png|jpg|d\.ts)/.test(pathway)) {
    return;
  }

  // replace relative imports with full path
  let module = pathway;
  if (/\.\//g.test(pathway) || /\.\.\//g.test(pathway)) {
    module = path.resolve(file, "..", pathway);
  }

  // initialise or increase reference count for file
  if (allImports.hasOwnProperty(module)) {
    allImports[module] = allImports[module] + 1;
  } else {
    allImports[module] = 1;
  }
};

/**
 * Check AST tree for any (j|tsx?) files and set a file
 * references for any import, require or dynamic import files.
 */
const parseFileASTTree = (file, allImports) => {
  const ast = babelParser.parse(
    fs.readFileSync(file, "utf-8"),
    babelParserOptions
  );
  babelTraverse(ast, {
    // Used for all ES6 import statements
    ImportDeclaration: (path) => {
      setFileRef(allImports, file, path.node.source.value);
    },
    // For require('') statements
    Identifier: (path) => {
      if (
        path.node.name === "require" &&
        path.parent.type === "CallExpression"
      ) {
        setFileRef(allImports, file, path.parent.arguments[0].value);
      }
    },
    // Use for dynamic imports like routes.jsx
    CallExpression: (path) => {
      if (path.node.callee.type === "Import") {
        setFileRef(allImports, file, path.node.arguments[0].value);
      }
    },
    // Use for export barrells
    ExportAllDeclaration: (path) => {
      setFileRef(allImports, file, path.node.source.value);
    },
    ExportNamedDeclaration: (path) => {
      // ensure there is a path export
      if (path.node.source) {
        setFileRef(allImports, file, path.node.source.value);
      }
    },
  });
};

/**
 * Return paths to all (j|tsx?) files.
 */
const getAllSrcJSAndTSFiles = (src) =>
  Promise.all([
    getAllFiles(src, ".js"),
    getAllFiles(src, ".jsx"),
    getAllFiles(src, ".ts"),
    getAllFiles(src, ".tsx"),
  ]);

/**
 * Where Node CLI runs from.
 */
const findJSImports = async (src) => {
  const allImports = {};
  const errFiles = [];
  try {
    const promiseMap = await getAllSrcJSAndTSFiles(src);
    const srcFiles = promiseMap.flatMap((d) => d);
    for (const file of srcFiles) {
      try {
        parseFileASTTree(file, allImports);
      } catch (err) {
        console.error(file, err.message);
        errFiles.push(file);
      }
    }

    return { allImports, errFiles };
  } catch (err) {
    console.error(err);
    return { allImports, errFiles };
  }
};
exports.findJSImports = findJSImports;