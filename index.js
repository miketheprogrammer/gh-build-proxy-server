const path          = require('path');
const os            = require('os');
const http          = require('http');
const https         = require('https');
const url           = require('url');
const querystring   = require('querystring');

const { spawn, exec }   = require('child_process');

const httpProxy     = require('http-proxy');
const getPort       = require('get-port');
const Greenlock     = require('greenlock');
const downloadRepo  = require('download-github-repo');
const URL           = require('url-parse');
const pem           = require('pem');
const serveStatic   = require('serve-static')
const finalhandler  = require('finalhandler');

const config        = require('./config.json')

const express = require('express');
const app = express();

const options = {secure: false}
const proxy = httpProxy.createProxyServer(options);

proxy.on('error', function(e) {
  console.log('Proxy Error', e);
});

var acmeEnv = config.letsEncrypt.acmeEnv;
var greenlock = Greenlock.create({
  agreeTos: true                      // Accept Let's Encrypt v2 Agreement
, approveDomains: approveDomains
, communityMember: true
, email: config.letsEncrypt.email
, challengeType: 'http-01'
, challenge: require('le-challenge-fs').create({})
, version: 'draft-12'
, server: 'https://acme-' + acmeEnv + 'v02.api.letsencrypt.org/directory'
, configDir: path.join(os.homedir(), 'acme/etc')
// , store: require('le-store-certbot').create({
//     configDir: path.join(os.homedir(), 'acme/etc')
//   , webrootPath: '/tmp/acme-challenges'
//   })
});

var http01 = require('le-challenge-fs').create({ webrootPath: '/tmp/acme-challenges' });
function approveDomains(opts, certs, cb) {
  // This is where you check your database and associated
  // email addresses with domains and agreements and such

  // Opt-in to submit stats and get important updates
  opts.communityMember = true;

  // If you wish to replace the default challenge plugin, you may do so here
  opts.challenges = { 'http-01': http01 };

  console.log('OPTS =-----=-', opts);
  console.log('CERTS =---=-', certs);
  // The domains being approved for the first time are listed in opts.domains
  // Certs being renewed are listed in certs.altnames
  if (certs) {
    opts.domains = certs.altnames;
  }
  else {
    opts.email = config.letsEncrypt.email;
    opts.agreeTos = true;
  }

  // NOTE: you can also change other options such as `challengeType` and `challenge`
  opts.challengeType = 'http-01';
  opts.challenge = require('le-challenge-fs').create({});
  console.log('cb exec');
  cb(null, { options: opts, certs: certs });
}

if (process.env.NODE_ENV !== 'prod') {
  http.createServer(greenlock.middleware(require('redirect-https')())).listen(80);
  pem.createCertificate({ days: 1, selfSigned: true }, function (err, keys) {
  if (err) {
    throw err
  }
  https.createServer({ key: keys.serviceKey, cert: keys.certificate }, app).listen(443)
})
} else {
  http.createServer(app).listen(80);
  https.createServer(greenlock.tlsOptions, app).listen(443);
}


// store references to static serves
let serveReferences = {}
pauseReferences = {}
function pauseUntilReference(repository, pollTime, req, res) {
  if (serveReferences[repository]) return;
  console.log('pausing');
  setTimeout(handler.bind(Object.create(null), req, res), pollTime);
}

function handleProcessError(repository, res) {
  return (e) => {
    console.error('Critical Error', e)
    pauseReferences[repository] = undefined;
    res.status(404).send('Page Not Found');
  }
}


function handler(req, res) {
  const host = req.headers.host;
  const path = req.url;
  console
  if (path.search('wp-') !== -1) {
    return proxy.web(req, res, { target: 'https://localhost:8000' });
  }
  const query = url.parse(req.url, true).query;
  var repository;
  try {
    repository = getRepository(host, path, res);
  } catch (err) {
    res.statusCode = 404;
    res.end();
    return;
  }

  console.log(
      host
    , path
    , repository
    , query
  );

  let doBuild = !serveReferences[repository] && !pauseReferences[repository];
  if (query.force) doBuild = true;

  if (doBuild) {
    pauseReferences[repository] = true;
    console.log('downloading');
    downloadRepository(repository).then((result) => {
      console.log('installing npm modules');
      installNpmModules(repository).then(() => {
        build(repository).then(() => {
          serve(repository, req, res);
        }).catch(handleProcessError(repository, res));
      }).catch(handleProcessError(repository, res));
    }).catch(handleProcessError(repository, res));
  } else {
    pauseUntilReference(repository, 100, req, res);
    return serve(repository, req, res);
  }
}

app.use(handler);

function getSafeRepositoryFilePath(repository) {
  return './.' + repository.replace('/', '-');
}

function getRepositoryContextOverrideOrDefault(repository) {
  let defaults = {
    cmd: "yarn build",
    root: "./app",
    build: "./app/build"
  }

  return Object.assign(defaults, config.ghMappingOverrides[repository]);
}

async function installNpmModules(repository) {
  let safeRepository = getSafeRepositoryFilePath(repository);
  let conf = getRepositoryContextOverrideOrDefault(repository);
  conf.cmd = conf.cmd.split(' ');
  let promise = new Promise((resolve, reject) => {
    let ps = spawn('npm', ['install'], {
      cwd: path.join(getSafeRepositoryFilePath(repository), conf.root),
    })
    ps.stdout.pipe(process.stdout);
    ps.stderr.pipe(process.stderr);
    ps.on('close', (code) => {
      if (code !== 0) {
        return reject(code);
      }
      return resolve(code);
    });

  });

  await promise;

}

async function build(repository) {
  let safeRepository = getSafeRepositoryFilePath(repository);
  let conf = getRepositoryContextOverrideOrDefault(repository);
  conf.cmd = conf.cmd.split(' ');
  let promise = new Promise((resolve, reject) => {
    let ps = spawn(conf.cmd.splice(0,1)[0], conf.cmd, {
      cwd: path.join(getSafeRepositoryFilePath(repository), conf.root),
    })
    ps.stdout.pipe(process.stdout);
    ps.stderr.pipe(process.stderr);
    ps.on('close', (code) => {
      if (code !== 0) {
        return reject(code);
      }
      return resolve(code);
    });
  });

  await promise;

}

function serve(repository, req, res) {
  let conf = getRepositoryContextOverrideOrDefault(repository);
  let _serve = serveReferences[repository];
  if (!_serve) {
    _serve = serveStatic(path.join(getSafeRepositoryFilePath(repository), conf.build), {'index': ['index.html', 'index.htm']});
    serveReferences[repository] = _serve;
  }
  _serve(req, res, finalhandler(req, res))
}

async function downloadRepository(repository) {
  let safeRepository = getSafeRepositoryFilePath(repository);
  let download = new Promise((resolve, reject) => {
    downloadRepo(repository, safeRepository, (err) => {
      if (err) {
        return reject(err);
      }
      return resolve();
    })
  })
  await download;
}

function getRepository(host, path) {
  if (config.useSubdomain) {
    const parts = host.split('.');
    let repository;
    if (parts.length < 3) {
      console.warn('Warning: Did not find subdomain in Host header. Checking ghMappingOverrides for a domain')
      const override = config.ghMappingOverrides[host];
      if (!override) {
        console.warn('Warning: Could not find mapping. Ending request with 404');
        throw new Error("ERR_NO_MAPPING_FOR_BASE");
      }
      repository = override.repository;
    }

    if (parts.length === 3) {
      repository = config.defaultUserName + '/' + parts[0];
      const override = config.ghMappingOverrides[host];
      if (!override) {
        console.warn('Warning: Could not find mapping. Using:', repository);
      } else {
        repository = override.repository;
      }

    }
    return repository;
  }

  if (config.usePath) {
    const override = config.ghMappingOverrides[path];
    if (override) {
      return override.repository;
    }

    let name = path.substr(1); // remove leading /

    if (!name) {
      console.warn('Warning: No Path segment');
      res.statusCode = 404;
      res.end();
    }

    if (name.indexOf('/') !== -1) {
      // we might have a repository name
      // lets try it
      return name;
    }

    return config.defaultUserName + '/' + name;

    // check for mapping

  }
}
