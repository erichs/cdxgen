const readInstalled = require("read-installed");
const parsePackageJsonName = require("parse-packagejson-name");
const os = require("os");
const pathLib = require("path");
const request = require("request");
const ssri = require("ssri");
const fs = require("fs");
const uuidv4 = require("uuid/v4");
const PackageURL = require("packageurl-js");
const builder = require("xmlbuilder");
const utils = require("./utils");
const { spawnSync } = require("child_process");
const selfPjson = require("./package.json");
const { findJSImports } = require("./analyzer");
const semver = require("semver");

// Construct maven command
let MVN_CMD = "mvn";
if (process.env.MVN_CMD) {
  MVN_CMD = process.env.MVN_CMD;
} else if (process.env.MAVEN_HOME) {
  MVN_CMD = pathLib.join(process.env.MAVEN_HOME, "bin", "mvn");
}

// Construct gradle cache directory
let GRADLE_CACHE_DIR =
  process.env.GRADLE_CACHE_DIR ||
  pathLib.join(os.homedir(), ".gradle", "caches", "modules-2", "files-2.1");
if (process.env.GRADLE_USER_HOME) {
  GRADLE_CACHE_DIR =
    process.env.GRADLE_USER_HOME + "/caches/modules-2/files-2.1";
}

// Construct sbt cache directory
let SBT_CACHE_DIR =
  process.env.SBT_CACHE_DIR || pathLib.join(os.homedir(), ".ivy2", "cache");

// Debug mode flag
const DEBUG_MODE =
  process.env.SCAN_DEBUG_MODE === "debug" ||
  process.env.SHIFTLEFT_LOGGING_LEVEL === "debug" ||
  process.env.NODE_ENV !== "production";

// CycloneDX Hash pattern
const HASH_PATTERN =
  "^([a-fA-F0-9]{32}|[a-fA-F0-9]{40}|[a-fA-F0-9]{64}|[a-fA-F0-9]{96}|[a-fA-F0-9]{128})$";

// Timeout milliseconds. Default 10 mins
const TIMEOUT_MS = process.env.CDXGEN_TIMEOUT_MS || 10 * 60 * 1000;

/**
 * Method to create global external references
 *
 * @param pkg
 * @returns {Array}
 */
function addGlobalReferences(src, filename) {
  let externalReferences = [];
  externalReferences.push({
    reference: { "@type": "other", url: src, comment: "Base path" },
  });
  let packageFileMeta = filename;
  if (!filename.includes(src)) {
    packageFileMeta = pathLib.join(src, filename);
  }
  externalReferences.push({
    reference: {
      "@type": "other",
      url: packageFileMeta,
      comment: "Package file",
    },
  });
  return externalReferences;
}

/**
 * Function to create metadata block
 *
 */
function addMetadata() {
  let metadata = {
    timestamp: new Date().toISOString(),
    tools: [
      {
        tool: {
          vendor: "AppThreat",
          name: "cdxgen",
          version: selfPjson.version,
        },
      },
    ],
    authors: [
      {
        author: { name: selfPjson.author, email: "cloud@appthreat.com" },
      },
    ],
    supplier: undefined,
  };
  return metadata;
}

/**
 * Method to create external references
 *
 * @param pkg
 * @returns {Array}
 */
function addExternalReferences(pkg, format = "xml") {
  let externalReferences = [];
  if (format === "xml") {
    if (pkg.homepage) {
      externalReferences.push({
        reference: { "@type": "website", url: pkg.homepage },
      });
    }
    if (pkg.bugs && pkg.bugs.url) {
      externalReferences.push({
        reference: { "@type": "issue-tracker", url: pkg.bugs.url },
      });
    }
    if (pkg.repository && pkg.repository.url) {
      externalReferences.push({
        reference: { "@type": "vcs", url: pkg.repository.url },
      });
    }
  } else {
    if (pkg.homepage) {
      externalReferences.push({
        type: "website",
        url: pkg.homepage,
      });
    }
    if (pkg.bugs && pkg.bugs.url) {
      externalReferences.push({
        type: "issue-tracker",
        url: pkg.bugs.url,
      });
    }
    if (pkg.repository && pkg.repository.url) {
      externalReferences.push({
        type: "vcs",
        url: pkg.repository.url,
      });
    }
  }
  return externalReferences;
}

/**
 * For all modules in the specified package, creates a list of
 * component objects from each one.
 */
exports.listComponents = listComponents;
function listComponents(allImports, pkg, ptype = "npm", format = "xml") {
  let list = {};
  let isRootPkg = ptype === "npm";
  if (Array.isArray(pkg)) {
    pkg.forEach((p) => {
      addComponent(allImports, p, ptype, list, false, format);
    });
  } else {
    addComponent(allImports, pkg, ptype, list, isRootPkg, format);
  }
  if (format === "xml") {
    return Object.keys(list).map((k) => ({ component: list[k] }));
  } else {
    return Object.keys(list).map((k) => list[k]);
  }
}

/**
 * Given the specified package, create a CycloneDX component and add it to the list.
 */
function addComponent(
  allImports,
  pkg,
  ptype,
  list,
  isRootPkg = false,
  format = "xml"
) {
  //read-installed with default options marks devDependencies as extraneous
  //if a package is marked as extraneous, do not include it as a component
  if (pkg.extraneous) return;
  if (!isRootPkg) {
    let pkgIdentifier = parsePackageJsonName(pkg.name);
    let group = pkg.group || pkgIdentifier.scope;
    // Create empty group
    group = group || "";
    let name = pkgIdentifier.fullName || pkg.name;
    // Skip @types package for npm
    if (ptype == "npm" && (group === "types" || name.startsWith("@types"))) {
      return;
    }
    let version = pkg.version;
    let licenses = utils.getLicenses(pkg, format);
    let purl = new PackageURL(
      ptype,
      group,
      name,
      version,
      pkg.qualifiers,
      pkg.subpath
    );
    let purlString = purl.toString();
    purlString = decodeURIComponent(purlString);
    let component = {
      group: group,
      name: name,
      version: version,

      hashes: [],
      licenses: licenses,
      purl: purlString,
      externalReferences: addExternalReferences(pkg, format),
    };
    let compScope = pkg.scope;
    if (allImports) {
      const impPkgs = Object.keys(allImports);
      if (
        impPkgs.includes(name) ||
        impPkgs.includes(group + "/" + name) ||
        impPkgs.includes("@" + group + "/" + name) ||
        impPkgs.includes(group) ||
        impPkgs.includes("@" + group)
      ) {
        compScope = "required";
      } else if (impPkgs.length) {
        compScope = "optional";
      }
    }
    if (compScope) {
      component["scope"] = compScope;
    }
    if (format === "xml") {
      component["@type"] = determinePackageType(pkg);
      component["@bom-ref"] = purlString;
      component["description"] = { "#cdata": pkg.description };
    } else {
      component["type"] = determinePackageType(pkg);
      component["bom-ref"] = purlString;
      component["description"] = pkg.description;
    }
    if (
      component.externalReferences === undefined ||
      component.externalReferences.length === 0
    ) {
      delete component.externalReferences;
    }

    processHashes(pkg, component, format);

    if (list[component.purl]) return; //remove cycles
    list[component.purl] = component;
  }
  if (pkg.dependencies) {
    Object.keys(pkg.dependencies)
      .map((x) => pkg.dependencies[x])
      .filter((x) => typeof x !== "string") //remove cycles
      .map((x) => addComponent(allImports, x, ptype, list, false, format));
  }
}

/**
 * If the author has described the module as a 'framework', the take their
 * word for it, otherwise, identify the module as a 'library'.
 */
function determinePackageType(pkg) {
  if (pkg.hasOwnProperty("keywords")) {
    for (let keyword of pkg.keywords) {
      if (keyword.toLowerCase() === "framework") {
        return "framework";
      }
    }
  }
  return "library";
}

/**
 * Uses the SHA1 shasum (if present) otherwise utilizes Subresource Integrity
 * of the package with support for multiple hashing algorithms.
 */
function processHashes(pkg, component, format = "xml") {
  if (pkg._shasum) {
    let ahash = { "@alg": "SHA-1", "#text": pkg._shasum };
    if (format === "json") {
      ahash = { alg: "SHA-1", content: pkg._shasum };
      component.hashes.push(ahash);
    } else {
      component.hashes.push({
        hash: ahash,
      });
    }
  } else if (pkg._integrity) {
    let integrity = ssri.parse(pkg._integrity);
    // Components may have multiple hashes with various lengths. Check each one
    // that is supported by the CycloneDX specification.
    if (integrity.hasOwnProperty("sha512")) {
      addComponentHash(
        "SHA-512",
        integrity.sha512[0].digest,
        component,
        format
      );
    }
    if (integrity.hasOwnProperty("sha384")) {
      addComponentHash(
        "SHA-384",
        integrity.sha384[0].digest,
        component,
        format
      );
    }
    if (integrity.hasOwnProperty("sha256")) {
      addComponentHash(
        "SHA-256",
        integrity.sha256[0].digest,
        component,
        format
      );
    }
    if (integrity.hasOwnProperty("sha1")) {
      addComponentHash("SHA-1", integrity.sha1[0].digest, component, format);
    }
  }
  if (component.hashes.length === 0) {
    delete component.hashes; // If no hashes exist, delete the hashes node (it's optional)
  }
}

/**
 * Adds a hash to component.
 */
function addComponentHash(alg, digest, component, format = "xml") {
  let hash = "";
  // If it is a valid hash simply use it
  if (new RegExp(HASH_PATTERN).test(digest)) {
    hash = digest;
  } else {
    // Check if base64 encoded
    const isBase64Encoded =
      Buffer.from(digest, "base64").toString("base64") === digest;
    hash = isBase64Encoded
      ? Buffer.from(digest, "base64").toString("hex")
      : digest;
  }
  let ahash = { "@alg": alg, "#text": hash };
  if (format === "json") {
    ahash = { alg: alg, content: hash };
    component.hashes.push(ahash);
  } else {
    component.hashes.push({ hash: ahash });
  }
}

const buildBomString = (
  { includeBomSerialNumber, pkgInfo, ptype, context },
  callback
) => {
  let bom = builder
    .create("bom", { encoding: "utf-8", separateArrayItems: true })
    .att("xmlns", "http://cyclonedx.org/schema/bom/1.2");
  const serialNum = "urn:uuid:" + uuidv4();
  if (includeBomSerialNumber) {
    bom.att("serialNumber", serialNum);
  }
  bom.att("version", 1);
  if (context && context.src && context.filename) {
    bom
      .ele("externalReferences")
      .ele(addGlobalReferences(context.src, context.filename));
  }
  let allImports = {};
  if (context && context.allImports) {
    allImports = context.allImports;
  }
  const nsMapping = context.nsMapping || {};
  const metadata = addMetadata();
  bom.ele("metadata").ele(metadata);
  const components = listComponents(allImports, pkgInfo, ptype, "xml");
  if (components && components.length) {
    bom.ele("components").ele(components);
    let bomString = bom.end({
      pretty: true,
      indent: "  ",
      newline: "\n",
      width: 0,
      allowEmpty: false,
      spacebeforeslash: "",
    });
    // CycloneDX 1.2 Json Template
    let jsonTpl = {
      bomFormat: "CycloneDX",
      specVersion: "1.2",
      serialNumber: serialNum,
      version: 1,
      metadata: metadata,
      components: listComponents(allImports, pkgInfo, ptype, "json"),
    };
    callback(null, bomString, JSON.stringify(jsonTpl, null, 2), nsMapping);
  } else {
    callback();
  }
};

/**
 * Function to create bom string for Java projects
 *
 * @param includeBomSerialNumber Boolean to include BOM serial number
 * @param path to the project
 * @param options Parse options from the cli
 * @param callback Function callback
 */
const createJavaBom = async (
  includeBomSerialNumber,
  path,
  options,
  callback
) => {
  let jarNSMapping = {};
  let pkgList = [];
  // war/ear mode
  if (path.endsWith(".war")) {
    // Check if the file exists
    if (fs.existsSync(path)) {
      if (DEBUG_MODE) {
        console.log(`Retrieving packages from ${path}`);
      }
      let tempDir = fs.mkdtempSync(pathLib.join(os.tmpdir(), "war-deps-"));
      pkgList = utils.extractJarArchive(path, tempDir);
      if (pkgList.length) {
        pkgList = await utils.getMvnMetadata(pkgList);
      }
      // Should we attempt to resolve class names
      if (options.resolveClass) {
        console.log(
          "Creating class names list based on available jars. This might take a few mins ..."
        );
        jarNSMapping = utils.collectJarNS(tempDir);
      }
      // Clean up
      if (tempDir && tempDir.startsWith(os.tmpdir())) {
        console.log(`Cleaning up ${tempDir}`);
        fs.rmdirSync(tempDir, { recursive: true });
      }
    } else {
      console.log(`${path} doesn't exist`);
    }
    buildBomString(
      {
        includeBomSerialNumber,
        pkgInfo: pkgList,
        ptype: "maven",
        context: {
          src: pathLib.dirname(path),
          filename: path,
          nsMapping: jarNSMapping,
        },
      },
      callback
    );
  } else {
    // maven - pom.xml
    const pomFiles = utils.getAllFiles(path, "pom.xml");
    if (pomFiles && pomFiles.length) {
      let mvnArgs = [
        "org.cyclonedx:cyclonedx-maven-plugin:2.3.0:makeAggregateBom",
      ];
      // Support for passing additional settings and profile to maven
      if (process.env.MVN_ARGS) {
        const addArgs = process.env.MVN_ARGS.split(" ");
        mvnArgs = mvnArgs.concat(addArgs);
      }
      for (let i in pomFiles) {
        const f = pomFiles[i];
        const basePath = pathLib.dirname(f);
        // Should we attempt to resolve class names
        if (options.resolveClass) {
          console.log(
            "Creating class names list based on available jars. This might take a few mins ..."
          );
          jarNSMapping = utils.collectMvnDependencies(MVN_CMD, basePath);
        }
        console.log(`Executing '${MVN_CMD} ${mvnArgs.join(" ")}' in`, basePath);
        result = spawnSync(MVN_CMD, mvnArgs, {
          cwd: basePath,
          shell: true,
          encoding: "utf-8",
          timeout: TIMEOUT_MS,
        });
        if (result.status == 1 || result.error) {
          let tempDir = fs.mkdtempSync(pathLib.join(os.tmpdir(), "cdxmvn-"));
          let tempMvnTree = pathLib.join(tempDir, "mvn-tree.txt");
          let mvnTreeArgs = ["dependency:tree", "-DoutputFile=" + tempMvnTree];
          if (process.env.MVN_ARGS) {
            const addArgs = process.env.MVN_ARGS.split(" ");
            mvnTreeArgs = mvnTreeArgs.concat(addArgs);
          }
          console.log(
            `Fallback to executing ${MVN_CMD} ${mvnTreeArgs.join(" ")}`
          );
          result = spawnSync(MVN_CMD, mvnTreeArgs, {
            cwd: basePath,
            shell: true,
            encoding: "utf-8",
            timeout: TIMEOUT_MS,
          });
          if (result.status == 1 || result.error) {
            console.error(result.stdout, result.stderr);
            console.log(
              "Resolve the above maven error. This could be due to the following:\n"
            );
            console.log(
              "1. Java version requirement - Scan or the CI build agent could be using an incompatible version"
            );
            console.log(
              "2. Private maven repository is not serving all the required maven plugins correctly. Refer to your registry documentation to add support for jitpack.io"
            );
            console.log(
              "3. Check if all required environment variables including any maven profile arguments are passed correctly to this tool"
            );
            console.log(
              "\nFalling back to manual pom.xml parsing. The result would be incomplete!"
            );
            const dlist = utils.parsePom(f);
            if (dlist && dlist.length) {
              pkgList = pkgList.concat(dlist);
            }
          } else {
            if (fs.existsSync(tempMvnTree)) {
              const mvnTreeString = fs.readFileSync(tempMvnTree, {
                encoding: "utf-8",
              });
              const dlist = utils.parseMavenTree(mvnTreeString);
              if (dlist && dlist.length) {
                pkgList = pkgList.concat(dlist);
              }
              fs.unlinkSync(tempMvnTree);
            }
          }
          pkgList = await utils.getMvnMetadata(pkgList);
          return buildBomString(
            {
              includeBomSerialNumber,
              pkgInfo: pkgList,
              ptype: "maven",
              context: {
                src: path,
                filename: "pom.xml",
                nsMapping: jarNSMapping,
              },
            },
            callback
          );
        }
      } // for
      const firstPath = pathLib.dirname(pomFiles[0]);
      if (fs.existsSync(pathLib.join(firstPath, "target", "bom.xml"))) {
        const bomString = fs.readFileSync(
          pathLib.join(firstPath, "target", "bom.xml"),
          { encoding: "utf-8" }
        );
        let bomJonString = "";
        if (fs.existsSync(pathLib.join(firstPath, "target", "bom.json"))) {
          bomJonString = fs.readFileSync(
            pathLib.join(firstPath, "target", "bom.json"),
            { encoding: "utf-8" }
          );
        }
        callback(null, bomString, bomJonString, jarNSMapping);
      } else {
        const bomFiles = utils.getAllFiles(path, "bom.xml");
        const bomJsonFiles = utils.getAllFiles(path, "bom.json");
        callback(null, bomFiles, bomJsonFiles, jarNSMapping);
      }
    }
    // gradle
    let gradleFiles = utils.getAllFiles(
      path,
      (options.multiProject ? "**/" : "") + "build.gradle*"
    );
    if (gradleFiles && gradleFiles.length) {
      let GRADLE_CMD = "gradle";
      if (process.env.GRADLE_HOME) {
        GRADLE_CMD = pathLib.join(process.env.GRADLE_HOME, "bin", "gradle");
      }
      // Use local gradle wrapper if available
      if (fs.existsSync(path, "gradlew")) {
        // Enable execute permission
        try {
          fs.chmodSync(pathLib.join(path, "gradlew"), 0o775);
        } catch (e) {}
        GRADLE_CMD = pathLib.join(path, "gradlew");
      }
      for (let i in gradleFiles) {
        const f = gradleFiles[i];
        const basePath = pathLib.dirname(f);
        console.log("Executing", GRADLE_CMD, "dependencies in", basePath);
        const result = spawnSync(
          GRADLE_CMD,
          ["dependencies", "-q", "--console", "plain"],
          { cwd: basePath, encoding: "utf-8", timeout: TIMEOUT_MS }
        );
        if (result.status == 1 || result.error) {
          console.error(result.stdout, result.stderr);
        }
        const stdout = result.stdout;
        if (stdout) {
          const cmdOutput = Buffer.from(stdout).toString();
          const dlist = utils.parseGradleDep(cmdOutput);
          if (dlist && dlist.length) {
            pkgList = pkgList.concat(dlist);
          }
        }
      }
      pkgList = await utils.getMvnMetadata(pkgList);
      // Should we attempt to resolve class names
      if (options.resolveClass) {
        console.log(
          "Creating class names list based on available jars. This might take a few mins ..."
        );
        jarNSMapping = utils.collectJarNS(GRADLE_CACHE_DIR);
      }
      buildBomString(
        {
          includeBomSerialNumber,
          pkgInfo: pkgList,
          ptype: "maven",
          context: {
            src: path,
            filename: "build.gradle",
            nsMapping: jarNSMapping,
          },
        },
        callback
      );
    }
    // scala sbt
    let sbtFiles = utils.getAllFiles(
      path,
      (options.multiProject ? "**/" : "") + "build.sbt"
    );
    let sbtLockFiles = utils.getAllFiles(
      path,
      (options.multiProject ? "**/" : "") + "build.sbt.lock"
    );

    if (sbtFiles && sbtFiles.length) {
      // If the project use sbt lock files
      if (sbtLockFiles && sbtLockFiles.length) {
        for (let i in sbtLockFiles) {
          const f = sbtLockFiles[i];
          const dlist = utils.parseSbtLock(f);
          if (dlist && dlist.length) {
            pkgList = pkgList.concat(dlist);
          }
        }
      } else {
        let SBT_CMD = process.env.SBT_CMD || "sbt";
        let sbtVersion = utils.determineSbtVersion(path);
        if (DEBUG_MODE) {
          console.log("Detected sbt version: " + sbtVersion);
        }
        const standalonePluginFile =
          sbtVersion != null && semver.gte(sbtVersion, "1.2.0");
        let tempDir = fs.mkdtempSync(pathLib.join(os.tmpdir(), "cdxsbt-"));
        let tempSbtgDir = fs.mkdtempSync(pathLib.join(os.tmpdir(), "cdxsbtg-"));
        fs.mkdirSync(tempSbtgDir, { recursive: true });
        // Create temporary plugins file
        let tempSbtPlugins = pathLib.join(tempSbtgDir, "dep-plugins.sbt");

        // Requires a custom version of `sbt-dependency-graph` that
        // supports `--append` for `toFile` subtask.
        const sbtPluginDefinition = `\naddSbtPlugin("io.shiftleft" % "sbt-dependency-graph" % "0.10.0-append-to-file3")\n`;
        fs.writeFileSync(tempSbtPlugins, sbtPluginDefinition);

        for (let i in sbtFiles) {
          const f = sbtFiles[i];
          const basePath = pathLib.dirname(f);
          let dlFile = pathLib.join(tempDir, "dl-" + i + ".tmp");
          console.log(
            "Executing",
            SBT_CMD,
            "dependencyList in",
            basePath,
            "using plugins",
            tempSbtgDir
          );
          var sbtArgs = [];
          var pluginFile = null;
          if (standalonePluginFile) {
            sbtArgs = [
              `-addPluginSbtFile=${tempSbtPlugins}`,
              `dependencyList::toFile "${dlFile}" --append`,
            ];
          } else {
            // write to the existing plugins file
            sbtArgs = [`dependencyList::toFile "${dlFile}" --append`];
            pluginFile = utils.addPlugin(basePath, sbtPluginDefinition);
          }
          const result = spawnSync(SBT_CMD, sbtArgs, {
            cwd: basePath,
            encoding: "utf-8",
            timeout: TIMEOUT_MS,
          });
          if (result.status == 1 || result.error) {
            console.error(result.stdout, result.stderr);
            if (DEBUG_MODE) {
              console.log(
                `1. Check if scala and sbt is installed and available in PATH. Only scala 2.10 + sbt 0.13.6+ and 2.12 + sbt 1.0+ is supported for now.`
              );
              console.log(
                `2. Check if the plugin net.virtual-void:sbt-dependency-graph 0.10.0-RC1 can be used in the environment`
              );
              console.log(
                "3. Consider creating a lockfile using sbt-dependency-lock plugin. See https://github.com/stringbean/sbt-dependency-lock"
              );
            }
          } else if (DEBUG_MODE) {
            console.log(result.stdout);
          }
          if (!standalonePluginFile) {
            utils.cleanupPlugin(basePath, pluginFile);
          }
          if (fs.existsSync(dlFile)) {
            const cmdOutput = fs.readFileSync(dlFile, { encoding: "utf-8" });
            if (DEBUG_MODE) {
              console.log(cmdOutput);
            }
            const dlist = utils.parseKVDep(cmdOutput);
            if (dlist && dlist.length) {
              pkgList = pkgList.concat(dlist);
            }
          } else {
            if (DEBUG_MODE) {
              console.log(`sbt dependencyList did not yield ${dlFile}`);
            }
          }
        }

        // Cleanup
        fs.unlinkSync(tempSbtPlugins);
      } // else

      if (DEBUG_MODE) {
        console.log(`Found ${pkgList.length} packages`);
      }
      pkgList = await utils.getMvnMetadata(pkgList);
      // Should we attempt to resolve class names
      if (options.resolveClass) {
        console.log(
          "Creating class names list based on available jars. This might take a few mins ..."
        );
        jarNSMapping = utils.collectJarNS(SBT_CACHE_DIR);
      }
      buildBomString(
        {
          includeBomSerialNumber,
          pkgInfo: pkgList,
          ptype: "maven",
          context: {
            src: path,
            filename: sbtFiles.join(", "),
            nsMapping: jarNSMapping,
          },
        },
        callback
      );
    }
  }
};

/**
 * Function to create bom string for Node.js projects
 *
 * @param includeBomSerialNumber Boolean to include BOM serial number
 * @param path to the project
 * @param options Parse options from the cli
 * @param callback Function callback
 */
const createNodejsBom = async (
  includeBomSerialNumber,
  path,
  options,
  callback
) => {
  const yarnLockFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "yarn.lock"
  );
  const pkgLockFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "package-lock.json"
  );
  const pnpmLockFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "pnpm-lock.yaml"
  );
  const { allImports } = await findJSImports(path);
  if (pnpmLockFiles && pnpmLockFiles.length) {
    let pkgList = [];
    for (let i in pnpmLockFiles) {
      const f = pnpmLockFiles[i];
      const dlist = utils.parsePnpmLock(f);
      if (dlist && dlist.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    return buildBomString(
      {
        includeBomSerialNumber,
        pkgInfo: pkgList,
        ptype: "npm",
        context: { allImports, src: path, filename: "pnpm-lock.yaml" },
      },
      callback
    );
  } else if (pkgLockFiles && pkgLockFiles.length) {
    let pkgList = [];
    for (let i in pkgLockFiles) {
      const f = pkgLockFiles[i];
      // Parse package-lock.json if available
      const dlist = await utils.parsePkgLock(f);
      if (dlist && dlist.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    return buildBomString(
      {
        includeBomSerialNumber,
        pkgInfo: pkgList,
        ptype: "npm",
        context: { allImports, src: path, filename: "package-lock.json" },
      },
      callback
    );
  } else if (fs.existsSync(pathLib.join(path, "node_modules"))) {
    readInstalled(path, options, (err, pkgInfo) => {
      buildBomString(
        {
          includeBomSerialNumber,
          pkgInfo,
          ptype: "npm",
          context: { allImports, src: path, filename: "package.json" },
        },
        callback
      );
    });
  } else if (fs.existsSync(pathLib.join(path, "rush.json"))) {
    // Rush.js creates node_modules inside common/temp directory
    const nmDir = pathLib.join(path, "common", "temp", "node_modules");
    // Do rush install if we don't have node_modules directory
    if (!fs.existsSync(nmDir)) {
      console.log("Executing 'rush install --no-link'", path);
      result = spawnSync("rush", ["install", "--no-link", "--bypass-policy"], {
        cwd: path,
        encoding: "utf-8",
      });
    }
    // Look for shrinkwrap file
    const swFile = pathLib.join(
      path,
      "tools",
      "build-tasks",
      ".rush",
      "temp",
      "shrinkwrap-deps.json"
    );
    const pnpmLock = pathLib.join(
      path,
      "common",
      "config",
      "rush",
      "pnpm-lock.yaml"
    );
    if (fs.existsSync(swFile)) {
      const pkgList = await utils.parseNodeShrinkwrap(swFile);
      return buildBomString(
        {
          includeBomSerialNumber,
          pkgInfo: pkgList,
          ptype: "npm",
          context: { allImports, src: path, filename: "shrinkwrap-deps.json" },
        },
        callback
      );
    } else if (fs.existsSync(pnpmLock)) {
      const pkgList = await utils.parsePnpmLock(pnpmLock);
      return buildBomString(
        {
          includeBomSerialNumber,
          pkgInfo: pkgList,
          ptype: "npm",
          context: { allImports, src: path, filename: "pnpm-lock.yaml" },
        },
        callback
      );
    } else {
      console.log(
        "Neither shrinkwrap file: ",
        swFile,
        " nor pnpm lockfile",
        pnpmLock,
        "was found!"
      );
    }
  } else if (yarnLockFiles && yarnLockFiles.length) {
    let pkgList = [];
    for (let i in yarnLockFiles) {
      const f = yarnLockFiles[i];
      // Parse yarn.lock if available. This check is after rush.json since
      // rush.js could include yarn.lock :(
      const dlist = await utils.parseYarnLock(f);
      if (dlist && dlist.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    return buildBomString(
      {
        includeBomSerialNumber,
        pkgInfo: pkgList,
        ptype: "npm",
        context: { allImports, src: path, filename: "yarn.lock" },
      },
      callback
    );
  } else {
    console.error(
      "Unable to find node_modules or package-lock.json or rush.json or yarn.lock at",
      path
    );
    callback();
  }
};

/**
 * Function to create bom string for Python projects
 *
 * @param includeBomSerialNumber Boolean to include BOM serial number
 * @param path to the project
 * @param options Parse options from the cli
 * @param callback Function callback
 */
const createPythonBom = async (
  includeBomSerialNumber,
  path,
  options,
  callback
) => {
  const pipenvMode = fs.existsSync(pathLib.join(path, "Pipfile"));
  const poetryMode = fs.existsSync(pathLib.join(path, "poetry.lock"));
  const reqFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "requirements.txt"
  );
  const reqDirFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "requirements/*.txt"
  );
  const setupPy = pathLib.join(path, "setup.py");
  const requirementsMode =
    (reqFiles && reqFiles.length) || (reqDirFiles && reqDirFiles.length);
  const setupPyMode = fs.existsSync(setupPy);
  if (requirementsMode || pipenvMode || poetryMode || setupPyMode) {
    if (pipenvMode) {
      spawnSync("pipenv", ["install"], { cwd: path, encoding: "utf-8" });
      const piplockFile = pathLib.join(path, "Pipfile.lock");
      if (fs.existsSync(piplockFile)) {
        const lockData = JSON.parse(fs.readFileSync(piplockFile));
        const pkgList = await utils.parsePiplockData(lockData);
        buildBomString(
          {
            includeBomSerialNumber,
            pkgInfo: pkgList,
            ptype: "pypi",
            context: { src: path, filename: "Pipfile.lock" },
          },
          callback
        );
      } else {
        console.error("Pipfile.lock not found at", path);
      }
    } else if (poetryMode) {
      const poetrylockFile = pathLib.join(path, "poetry.lock");
      const lockData = fs.readFileSync(poetrylockFile, {
        encoding: "utf-8",
      });
      const pkgList = await utils.parsePoetrylockData(lockData);
      buildBomString(
        {
          includeBomSerialNumber,
          pkgInfo: pkgList,
          ptype: "pypi",
          context: { src: path, filename: "poetry.lock" },
        },
        callback
      );
    } else if (requirementsMode) {
      let pkgList = [];
      let metadataFilename = "requirements.txt";
      if (reqFiles && reqFiles.length) {
        for (let i in reqFiles) {
          const f = reqFiles[i];
          const reqData = fs.readFileSync(f, { encoding: "utf-8" });
          const dlist = await utils.parseReqFile(reqData);
          if (dlist && dlist.length) {
            pkgList = pkgList.concat(dlist);
          }
        }
        metadataFilename = reqFiles.join(", ");
      } else if (reqDirFiles && reqDirFiles.length) {
        for (let j in reqDirFiles) {
          const f = reqDirFiles[j];
          const reqData = fs.readFileSync(f, { encoding: "utf-8" });
          const dlist = await utils.parseReqFile(reqData);
          if (dlist && dlist.length) {
            pkgList = pkgList.concat(dlist);
          }
        }
        metadataFilename = reqDirFiles.join(", ");
      }
      buildBomString(
        {
          includeBomSerialNumber,
          pkgInfo: pkgList,
          ptype: "pypi",
          context: { src: path, filename: metadataFilename },
        },
        callback
      );
    } else if (setupPyMode) {
      const setupPyData = fs.readFileSync(setupPy, { encoding: "utf-8" });
      const pkgList = await utils.parseSetupPyFile(setupPyData);
      buildBomString(
        {
          includeBomSerialNumber,
          pkgInfo: pkgList,
          ptype: "pypi",
          context: { src: path, filename: "setup.py" },
        },
        callback
      );
    } else {
      console.error(
        "Unable to find requirements.txt or Pipfile.lock for the python project at",
        path
      );
      callback();
    }
  }
};

/**
 * Function to create bom string for Go projects
 *
 * @param includeBomSerialNumber Boolean to include BOM serial number
 * @param path to the project
 * @param options Parse options from the cli
 * @param callback Function callback
 */
const createGoBom = async (includeBomSerialNumber, path, options, callback) => {
  let pkgList = [];

  // Read in go.sum and merge all go.sum files.
  const gosumFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "go.sum"
  );

  // If USE_GOSUM is true, generate BOM components only using go.sum.
  const useGosum = process.env.USE_GOSUM == "true";
  if (useGosum && gosumFiles.length) {
    console.warn(
      "Using go.sum to generate BOMs for go projects may return an inaccurate representation of transitive dependencies.\nSee: https://github.com/golang/go/wiki/Modules#is-gosum-a-lock-file-why-does-gosum-include-information-for-module-versions-i-am-no-longer-using\n",
      "Set USE_GOSUM=false to generate BOMs using go.mod as the dependency source of truth."
    );
    for (let i in gosumFiles) {
      const f = gosumFiles[i];
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const gosumData = fs.readFileSync(f, { encoding: "utf-8" });
      const dlist = await utils.parseGosumData(gosumData);
      if (dlist && dlist.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    return buildBomString(
      {
        includeBomSerialNumber,
        pkgInfo: pkgList,
        ptype: "golang",
        context: { src: path, filename: gosumFiles.join(", ") },
      },
      callback
    );
  }

  // If USE_GOSUM is false, generate BOM components using go.mod.
  gosumMap = {};
  if (gosumFiles.length) {
    for (let i in gosumFiles) {
      const f = gosumFiles[i];
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const gosumData = fs.readFileSync(f, { encoding: "utf-8" });
      const dlist = await utils.parseGosumData(gosumData);
      if (dlist && dlist.length) {
        dlist.forEach((pkg) => {
          gosumMap[`${pkg.group}/${pkg.name}/${pkg.version}`] = pkg._integrity;
        });
      }
    }
  }

  // Read in data from Gopkg.lock files if they exist
  const gopkgLockFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "Gopkg.lock"
  );

  // Read in go.mod files and parse BOM components with checksums from gosumData
  const gomodFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "go.mod"
  );
  if (gomodFiles.length) {
    for (let i in gomodFiles) {
      const f = gomodFiles[i];
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const gomodData = fs.readFileSync(f, { encoding: "utf-8" });
      const dlist = await utils.parseGoModData(gomodData, gosumMap);
      if (dlist && dlist.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    buildBomString(
      {
        includeBomSerialNumber,
        pkgInfo: pkgList,
        ptype: "golang",
        context: { src: path, filename: gomodFiles.join(", ") },
      },
      callback
    );
  } else if (gopkgLockFiles.length) {
    for (let i in gopkgLockFiles) {
      const f = gopkgLockFiles[i];
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const gopkgData = fs.readFileSync(f, {
        encoding: "utf-8",
      });
      const dlist = await utils.parseGopkgData(gopkgData);
      if (dlist && dlist.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    buildBomString(
      {
        includeBomSerialNumber,
        pkgInfo: pkgList,
        ptype: "golang",
        context: { src: path, filename: gopkgLockFiles.join(", ") },
      },
      callback
    );
  } else {
    console.error(
      "Unable to find go.sum or Gopkg.lock for the project at",
      path
    );
    callback();
  }
};

/**
 * Function to create bom string for Rust projects
 *
 * @param includeBomSerialNumber Boolean to include BOM serial number
 * @param path to the project
 * @param options Parse options from the cli
 * @param callback Function callback
 */
const createRustBom = async (
  includeBomSerialNumber,
  path,
  options,
  callback
) => {
  let cargoLockFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "Cargo.lock"
  );
  const cargoFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "Cargo.toml"
  );
  let pkgList = [];
  const cargoMode = cargoFiles.length;
  let cargoLockMode = cargoLockFiles.length;
  if (cargoMode && !cargoLockMode) {
    // Run cargo update in all directories with Cargo.toml
    for (let i in cargoFiles) {
      const f = cargoFiles[i];
      const basePath = pathLib.dirname(f);
      console.log("Executing 'cargo update' in", basePath);
      result = spawnSync("cargo", ["update"], {
        cwd: basePath,
        encoding: "utf-8",
      });
      if (result.status == 1 || result.error) {
        console.error(
          "cargo update has failed. Check if cargo is installed and available in PATH."
        );
        console.log(result.error, result.stderr);
      }
    }
  }
  // Get the new lock files
  cargoLockFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "Cargo.lock"
  );
  if (cargoLockFiles.length) {
    for (let i in cargoLockFiles) {
      const f = cargoLockFiles[i];
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const cargoData = fs.readFileSync(f, { encoding: "utf-8" });
      const dlist = await utils.parseCargoData(cargoData);
      if (dlist && dlist.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    buildBomString(
      {
        includeBomSerialNumber,
        pkgInfo: pkgList,
        ptype: "crates",
        context: { src: path, filename: cargoLockFiles.join(", ") },
      },
      callback
    );
  } else {
    console.error(
      "Unable to find or generate Cargo.lock for the rust project at",
      path
    );
    callback();
  }
};

/**
 * Function to create bom string for php projects
 *
 * @param includeBomSerialNumber Boolean to include BOM serial number
 * @param path to the project
 * @param options Parse options from the cli
 * @param callback Function callback
 */
const createPHPBom = async (
  includeBomSerialNumber,
  path,
  options,
  callback
) => {
  const composerJsonFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "composer.json"
  );
  let composerLockFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "composer.lock"
  );
  let pkgList = [];
  const composerJsonMode = composerJsonFiles.length;
  const composerLockMode = composerLockFiles.length;
  if (!composerLockMode && composerJsonMode) {
    for (let i in composerJsonFiles) {
      const f = composerJsonFiles[i];
      const basePath = pathLib.dirname(f);
      console.log("Executing 'composer install' in", basePath);
      result = spawnSync("composer", ["install"], {
        cwd: basePath,
        encoding: "utf-8",
      });
      if (result.status == 1 || result.error) {
        console.error(
          "Composer install has failed. Check if composer is installed and available in PATH."
        );
        console.log(result.error, result.stderr);
      }
    }
  }
  composerLockFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "composer.lock"
  );
  if (composerLockFiles.length) {
    for (let i in composerLockFiles) {
      const f = composerLockFiles[i];
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      let dlist = utils.parseComposerLock(f);
      if (dlist && dlist.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    buildBomString(
      {
        includeBomSerialNumber,
        pkgInfo: pkgList,
        ptype: "composer",
        context: { src: path, filename: composerLockFiles.join(", ") },
      },
      callback
    );
  } else {
    console.error(
      "Unable to find composer.lock or composer.json for the php project at",
      path
    );
    callback();
  }
};

/**
 * Function to create bom string for ruby projects
 *
 * @param includeBomSerialNumber Boolean to include BOM serial number
 * @param path to the project
 * @param options Parse options from the cli
 * @param callback Function callback
 */
const createRubyBom = async (
  includeBomSerialNumber,
  path,
  options,
  callback
) => {
  const gemFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "Gemfile"
  );
  let gemLockFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "Gemfile.lock"
  );
  let pkgList = [];
  const gemFileMode = gemFiles.length;
  let gemLockMode = gemLockFiles.length;
  if (gemFileMode && !gemLockMode) {
    for (let i in gemFiles) {
      const f = gemFiles[i];
      const basePath = pathLib.dirname(f);
      console.log("Executing 'bundle install' in", basePath);
      result = spawnSync("bundle", ["install"], {
        cwd: basePath,
        encoding: "utf-8",
      });
      if (result.status == 1 || result.error) {
        console.error(
          "Bundle install has failed. Check if bundle is installed and available in PATH."
        );
        console.log(result.error, result.stderr);
      }
    }
  }
  gemLockFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "Gemfile.lock"
  );
  if (gemLockFiles.length) {
    for (let i in gemLockFiles) {
      const f = gemLockFiles[i];
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      let gemLockData = fs.readFileSync(f, { encoding: "utf-8" });
      const dlist = await utils.parseGemfileLockData(gemLockData);
      if (dlist && dlist.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    buildBomString(
      {
        includeBomSerialNumber,
        pkgInfo: pkgList,
        ptype: "rubygems",
        context: { src: path, filename: gemLockFiles.join(", ") },
      },
      callback
    );
  } else {
    console.error("Unable to find Gemfile.lock for the ruby project at", path);
    callback();
  }
};

/**
 * Function to create bom string for csharp projects
 *
 * @param includeBomSerialNumber Boolean to include BOM serial number
 * @param path to the project
 * @param options Parse options from the cli
 * @param callback Function callback
 */
const createCsharpBom = async (
  includeBomSerialNumber,
  path,
  options,
  callback
) => {
  const csProjFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "*.csproj"
  );
  const pkgConfigFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "packages.config"
  );
  let pkgList = [];
  if (pkgConfigFiles.length) {
    for (let i in pkgConfigFiles) {
      const f = pkgConfigFiles[i];
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      let pkgData = fs.readFileSync(f, { encoding: "utf-8" });
      if (pkgData.charCodeAt(0) === 0xfeff) {
        pkgData = pkgData.slice(1);
      }
      const dlist = await utils.parseCsPkgData(pkgData);
      if (dlist && dlist.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
  } else if (csProjFiles.length) {
    for (let i in csProjFiles) {
      const f = csProjFiles[i];
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      let csProjData = fs.readFileSync(f, { encoding: "utf-8" });
      if (csProjData.charCodeAt(0) === 0xfeff) {
        csProjData = csProjData.slice(1);
      }
      const dlist = await utils.parseCsProjData(csProjData);
      if (dlist && dlist.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
  }
  if (pkgList.length) {
    buildBomString(
      {
        includeBomSerialNumber,
        pkgInfo: pkgList,
        ptype: "nuget",
        context: { src: path, filename: csProjFiles.join(", ") },
      },
      callback
    );
  } else {
    console.error("Unable to find .Net core dependencies at", path);
    callback();
  }
};

/**
 * Function to create bom string for various languages
 *
 * @param includeBomSerialNumber Boolean to include BOM serial number
 * @param path to the project
 * @param options Parse options from the cli
 * @param callback Function callback
 */
const createXBom = async (includeBomSerialNumber, path, options, callback) => {
  try {
    fs.accessSync(path, fs.constants.R_OK);
  } catch (err) {
    console.error(path, "is invalid");
    process.exit(1);
  }
  const { projectType } = options;
  // node.js - package.json
  if (
    fs.existsSync(pathLib.join(path, "package.json")) ||
    fs.existsSync(pathLib.join(path, "rush.json"))
  ) {
    return await createNodejsBom(
      includeBomSerialNumber,
      path,
      options,
      callback
    );
  }
  // maven - pom.xml
  const pomFiles = utils.getAllFiles(path, "pom.xml");
  // gradle
  let gradleFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "build.gradle*"
  );
  // scala sbt
  let sbtFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "build.sbt*"
  );
  if (pomFiles.length || gradleFiles.length || sbtFiles.length) {
    return await createJavaBom(includeBomSerialNumber, path, options, callback);
  }
  // python
  const pipenvMode = fs.existsSync(pathLib.join(path, "Pipfile"));
  const poetryMode = fs.existsSync(pathLib.join(path, "poetry.lock"));
  const reqFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "requirements.txt"
  );
  const reqDirFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "requirements/*.txt"
  );
  const setupPy = pathLib.join(path, "setup.py");
  const requirementsMode =
    (reqFiles && reqFiles.length) || (reqDirFiles && reqDirFiles.length);
  const setupPyMode = fs.existsSync(setupPy);
  if (requirementsMode || pipenvMode || poetryMode || setupPyMode) {
    return await createPythonBom(
      includeBomSerialNumber,
      path,
      options,
      callback
    );
  }
  // go
  const gosumFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "go.sum"
  );
  const gomodFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "go.mod"
  );
  const gopkgLockFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "Gopkg.lock"
  );
  if (gomodFiles.length || gosumFiles.length || gopkgLockFiles.length) {
    return await createGoBom(includeBomSerialNumber, path, options, callback);
  }

  // rust
  const cargoLockFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "Cargo.lock"
  );
  const cargoFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "Cargo.toml"
  );
  if (cargoLockFiles.length || cargoFiles.length) {
    return await createRustBom(includeBomSerialNumber, path, options, callback);
  }

  // php
  const composerJsonFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "composer.json"
  );
  const composerLockFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "composer.lock"
  );
  if (composerJsonFiles.length || composerLockFiles.length) {
    return await createPHPBom(includeBomSerialNumber, path, options, callback);
  }

  // Ruby
  const gemFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "Gemfile"
  );
  const gemLockFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "Gemfile.lock"
  );
  if (gemFiles.length || gemLockFiles.length) {
    return await createRubyBom(includeBomSerialNumber, path, options, callback);
  }

  // .Net
  const csProjFiles = utils.getAllFiles(
    path,
    (options.multiProject ? "**/" : "") + "*.csproj"
  );
  if (csProjFiles.length) {
    return await createCsharpBom(
      includeBomSerialNumber,
      path,
      options,
      callback
    );
  }
};

/**
 * Function to create bom string for various languages
 *
 * @param includeBomSerialNumber Boolean to include BOM serial number
 * @param path to the project
 * @param options Parse options from the cli
 * @param callback Function callback
 */
exports.createBom = async (includeBomSerialNumber, path, options, callback) => {
  let { projectType } = options;
  if (!projectType) {
    projectType = "";
  }
  projectType = projectType.toLowerCase();
  if (path.endsWith(".war")) {
    projectType = "java";
  }
  switch (projectType) {
    case "java":
    case "groovy":
    case "kotlin":
    case "scala":
    case "jvm":
      return await createJavaBom(
        includeBomSerialNumber,
        path,
        options,
        callback
      );
    case "nodejs":
    case "js":
    case "javascript":
    case "typescript":
    case "ts":
      return await createNodejsBom(
        includeBomSerialNumber,
        path,
        options,
        callback
      );
    case "python":
    case "py":
      return await createPythonBom(
        includeBomSerialNumber,
        path,
        options,
        callback
      );
    case "go":
    case "golang":
      return await createGoBom(includeBomSerialNumber, path, options, callback);
    case "rust":
    case "rust-lang":
      return await createRustBom(
        includeBomSerialNumber,
        path,
        options,
        callback
      );
    case "php":
      return await createPHPBom(
        includeBomSerialNumber,
        path,
        options,
        callback
      );
    case "ruby":
      return await createRubyBom(
        includeBomSerialNumber,
        path,
        options,
        callback
      );
    case "csharp":
    case "netcore":
    case "dotnet":
      return await createCsharpBom(
        includeBomSerialNumber,
        path,
        options,
        callback
      );
    default:
      return await createXBom(includeBomSerialNumber, path, options, callback);
  }
};

/**
 * Method to submit the generated bom to dependency-track or AppThreat server
 *
 * @param args CLI args
 */
exports.submitBom = function (args, bom, callback) {
  let serverUrl = args.serverUrl + "/api/v1/bom";

  const formData = {
    bom: {
      value: bom,
      options: {
        filename: args.output ? pathLib.basename(args.output) : "bom.xml",
        contentType: "text/xml",
      },
    },
  };
  if (args.projectId) {
    formData.project = args.projectId;
  } else if (args.projectName) {
    formData.projectName = args.projectName;
    formData.projectVersion = args.projectVersion;
    formData.autoCreate = "true";
  }
  const options = {
    method: "POST",
    url: serverUrl,
    port: 443,
    json: true,
    headers: {
      "X-Api-Key": args.apiKey,
      "Content-Type": "multipart/form-data",
    },
    formData,
  };
  request(options, callback);
};
