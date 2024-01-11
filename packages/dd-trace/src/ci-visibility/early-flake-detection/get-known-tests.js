// TODO: substitute by real request

// Tests from src/__tests__/cli.test.ts, missing "version <root>"
const FAKE_NAMES = [
  'cli all commands have the right metadata cloud-run flare',
  'cli all commands have the right metadata deployment (beta) mark',
  'cli all commands have the right metadata dora (beta) deployment',
  'cli all commands have the right metadata dsyms upload',
  'cli all commands have the right metadata flutter-symbols upload',
  'cli all commands have the right metadata gate evaluate',
  'cli all commands have the right metadata git-metadata upload',
  'cli all commands have the right metadata junit upload',
  'cli all commands have the right metadata lambda instrument',
  'cli all commands have the right metadata lambda uninstrument',
  'cli all commands have the right metadata lambda flare',
  'cli all commands have the right metadata metric <root>',
  'cli all commands have the right metadata react-native codepush',
  'cli all commands have the right metadata react-native upload',
  'cli all commands have the right metadata react-native xcode',
  'cli all commands have the right metadata sarif upload',
  'cli all commands have the right metadata sbom (beta) upload',
  'cli all commands have the right metadata sourcemaps upload',
  'cli all commands have the right metadata stepfunctions instrument',
  'cli all commands have the right metadata stepfunctions uninstrument',
  'cli all commands have the right metadata synthetics run-tests',
  'cli all commands have the right metadata synthetics upload-application',
  'cli all commands have the right metadata tag <root>',
  'cli all commands have the right metadata trace <root>',
  'cli all commands have the right metadata unity-symbols upload'
]

const FAKE_KNOWN_TESTS = FAKE_NAMES.map((name) => ({ suite: 'src/__tests__/cli.test.ts', name }))

function request (data, options, cb) {
  setTimeout(() => {
    cb(null, JSON.stringify({
      data: FAKE_KNOWN_TESTS.map(({ name, suite }) => ({
        attributes: {
          name,
          suite
        }
      }))
    }))
  }, 1000)
}

const log = require('../../log')

function getKnownTests ({
  url,
  isEvpProxy,
  env,
  service,
  repositoryUrl,
  sha,
  osVersion,
  osPlatform,
  osArchitecture,
  runtimeName,
  runtimeVersion,
  custom,
  testLevel = 'suite'
}, done) {
  const options = {
    path: '/api/v2/ci/tests/skippable',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    timeout: 20000,
    url
  }

  if (isEvpProxy) {
    options.path = '/evp_proxy/v2/api/v2/ci/tests/skippable'
    options.headers['X-Datadog-EVP-Subdomain'] = 'api'
  } else {
    const apiKey = process.env.DATADOG_API_KEY || process.env.DD_API_KEY
    if (!apiKey) {
      return done(new Error('Skippable suites were not fetched because Datadog API key is not defined.'))
    }

    options.headers['dd-api-key'] = apiKey
  }

  const data = JSON.stringify({
    data: {
      type: 'test_params',
      attributes: {
        test_level: testLevel,
        configurations: {
          'os.platform': osPlatform,
          'os.version': osVersion,
          'os.architecture': osArchitecture,
          'runtime.name': runtimeName,
          'runtime.version': runtimeVersion,
          custom
        },
        service,
        env,
        repository_url: repositoryUrl,
        sha
      }
    }
  })

  request(data, options, (err, res) => {
    if (err) {
      done(err)
    } else {
      let knownTests = []
      try {
        knownTests = JSON.parse(res)
          .data
          .reduce((acc, { attributes: { name, suite } }) => {
            if (acc[suite]) {
              acc[suite].push(name)
            } else {
              acc[suite] = [name]
            }
            return acc
          }, {})
        log.debug(() => `Number of received known tests: ${Object.keys(knownTests).length}`)
        done(null, knownTests)
      } catch (err) {
        done(err)
      }
    }
  })
}

module.exports = { getKnownTests }
