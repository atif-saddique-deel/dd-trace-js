const request = require('../../exporters/common/request')
const id = require('../../id')

// TODO: this will NOT work. We need to find a file name within the fullname
function splitByTestAndSuite (testFullname) {
  const [beforeExtension, afterExtention] = testFullname.split('test.ts.')
  const [, suite] = beforeExtension.split('.')
  return { suite: `${suite}.test.ts`, name: afterExtention }
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
  custom
}, done) {
  const options = {
    path: '/api/v2/ci/libraries/tests/known_tests',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    timeout: 20000,
    url
  }

  if (isEvpProxy) {
    options.path = '/evp_proxy/v2/api/v2/ci/libraries/tests/known_tests'
    options.headers['X-Datadog-EVP-Subdomain'] = 'api'
  } else {
    const apiKey = process.env.DATADOG_API_KEY || process.env.DD_API_KEY
    if (!apiKey) {
      return done(new Error('Skippable suites were not fetched because Datadog API key is not defined.'))
    }

    // It only works in agentless right now. TODO: make it work in agent
    options.headers['Accept-encoding'] = 'gzip'
    options.headers['dd-api-key'] = apiKey
  }

  const data = JSON.stringify({
    data: {
      id: id().toString(10),
      type: 'known_test_from_libraries_params',
      attributes: {
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
      let knownTests = {}
      try {
        knownTests = JSON.parse(res)
          .data
          .attributes
          .test_full_names.reduce((acc, testFullname) => {
            const { name, suite } = splitByTestAndSuite(testFullname)
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
