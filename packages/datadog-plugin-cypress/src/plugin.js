const {
  TEST_STATUS,
  TEST_IS_RUM_ACTIVE,
  TEST_CODE_OWNERS,
  getTestEnvironmentMetadata,
  CI_APP_ORIGIN,
  getTestParentSpan,
  getCodeOwnersFileEntries,
  getCodeOwnersForFilename,
  getTestCommonTags,
  getTestSessionCommonTags,
  getTestModuleCommonTags,
  getTestSuiteCommonTags,
  TEST_SUITE_ID,
  TEST_MODULE_ID,
  TEST_SESSION_ID,
  TEST_COMMAND,
  TEST_MODULE,
  TEST_SOURCE_START,
  finishAllTraceSpans,
  getCoveredFilenamesFromCoverage,
  getTestSuitePath,
  addIntelligentTestRunnerSpanTags,
  TEST_SKIPPED_BY_ITR,
  TEST_ITR_UNSKIPPABLE,
  TEST_ITR_FORCED_RUN,
  ITR_CORRELATION_ID
} = require('../../dd-trace/src/plugins/util/test')
const { ORIGIN_KEY, COMPONENT } = require('../../dd-trace/src/constants')
const log = require('../../dd-trace/src/log')
const NoopTracer = require('../../dd-trace/src/noop/tracer')
const { isMarkedAsUnskippable } = require('../../datadog-plugin-jest/src/util')
const {
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_EVENT_FINISHED,
  TELEMETRY_ITR_FORCED_TO_RUN,
  TELEMETRY_CODE_COVERAGE_EMPTY,
  TELEMETRY_ITR_UNSKIPPABLE,
  TELEMETRY_CODE_COVERAGE_NUM_FILES,
  incrementCountMetric,
  distributionMetric
} = require('../../dd-trace/src/ci-visibility/telemetry')
const { appClosing: appClosingTelemetry } = require('../../dd-trace/src/telemetry')
const {
  GIT_REPOSITORY_URL,
  GIT_COMMIT_SHA,
  GIT_BRANCH,
  CI_PROVIDER_NAME
} = require('../../dd-trace/src/plugins/util/tags')
const {
  OS_VERSION,
  OS_PLATFORM,
  OS_ARCHITECTURE,
  RUNTIME_NAME,
  RUNTIME_VERSION
} = require('../../dd-trace/src/plugins/util/env')

const TEST_FRAMEWORK_NAME = 'cypress'

const CYPRESS_STATUS_TO_TEST_STATUS = {
  passed: 'pass',
  failed: 'fail',
  pending: 'skip',
  skipped: 'skip'
}

function getTestSpanMetadata (tracer, testName, testSuite, cypressConfig) {
  const childOf = getTestParentSpan(tracer)

  const commonTags = getTestCommonTags(testName, testSuite, cypressConfig.version, TEST_FRAMEWORK_NAME)

  return {
    childOf,
    ...commonTags
  }
}

function getCypressVersion (details) {
  if (details && details.cypressVersion) {
    return details.cypressVersion
  }
  if (details && details.config && details.config.version) {
    return details.config.version
  }
  return ''
}

function getRootDir (details) {
  if (details && details.config) {
    return details.config.projectRoot || details.config.repoRoot || process.cwd()
  }
  return process.cwd()
}

function getCypressCommand (details) {
  if (!details) {
    return TEST_FRAMEWORK_NAME
  }
  return `${TEST_FRAMEWORK_NAME} ${details.specPattern || ''}`
}

function getSessionStatus (summary) {
  if (summary.totalFailed !== undefined && summary.totalFailed > 0) {
    return 'fail'
  }
  if (summary.totalSkipped !== undefined && summary.totalSkipped === summary.totalTests) {
    return 'skip'
  }
  return 'pass'
}

function getSuiteStatus (suiteStats) {
  if (suiteStats.failures !== undefined && suiteStats.failures > 0) {
    return 'fail'
  }
  if (suiteStats.tests !== undefined && suiteStats.tests === suiteStats.pending) {
    return 'skip'
  }
  return 'pass'
}

function getLibraryConfiguration (tracer, testConfiguration) {
  return new Promise(resolve => {
    if (!tracer._tracer._exporter?.getLibraryConfiguration) {
      return resolve({ err: new Error('CI Visibility was not initialized correctly') })
    }

    tracer._tracer._exporter.getLibraryConfiguration(testConfiguration, (err, libraryConfig) => {
      resolve({ err, libraryConfig })
    })
  })
}

function getSkippableTests (isSuitesSkippingEnabled, tracer, testConfiguration) {
  if (!isSuitesSkippingEnabled) {
    return Promise.resolve({ skippableTests: [] })
  }
  return new Promise(resolve => {
    if (!tracer._tracer._exporter?.getLibraryConfiguration) {
      return resolve({ err: new Error('CI Visibility was not initialized correctly') })
    }
    tracer._tracer._exporter.getSkippableSuites(testConfiguration, (err, skippableTests, correlationId) => {
      resolve({
        err,
        skippableTests,
        correlationId
      })
    })
  })
}

const noopTask = {
  'dd:testSuiteStart': () => {
    return null
  },
  'dd:beforeEach': () => {
    return {}
  },
  'dd:afterEach': () => {
    return null
  },
  'dd:addTags': () => {
    return null
  }
}

module.exports = (on, config) => {
  let isTestsSkipped = false
  const skippedTests = []
  const tracer = require('../../dd-trace')

  // The tracer was not init correctly for whatever reason (such as invalid DD_SITE)
  if (tracer._tracer instanceof NoopTracer) {
    // We still need to register these tasks or the support file will fail
    return on('task', noopTask)
  }

  const testEnvironmentMetadata = getTestEnvironmentMetadata(TEST_FRAMEWORK_NAME)

  const {
    [GIT_REPOSITORY_URL]: repositoryUrl,
    [GIT_COMMIT_SHA]: sha,
    [OS_VERSION]: osVersion,
    [OS_PLATFORM]: osPlatform,
    [OS_ARCHITECTURE]: osArchitecture,
    [RUNTIME_NAME]: runtimeName,
    [RUNTIME_VERSION]: runtimeVersion,
    [GIT_BRANCH]: branch,
    [CI_PROVIDER_NAME]: ciProviderName
  } = testEnvironmentMetadata

  const isUnsupportedCIProvider = !ciProviderName

  const finishedTestsByFile = {}

  const testConfiguration = {
    repositoryUrl,
    sha,
    osVersion,
    osPlatform,
    osArchitecture,
    runtimeName,
    runtimeVersion,
    branch,
    testLevel: 'test'
  }

  const codeOwnersEntries = getCodeOwnersFileEntries()

  let activeSpan = null
  let testSessionSpan = null
  let testModuleSpan = null
  let testSuiteSpan = null
  let command = null
  let frameworkVersion
  let rootDir
  let isSuitesSkippingEnabled = false
  let isCodeCoverageEnabled = false
  let testsToSkip = []
  let itrCorrelationId = ''
  const unskippableSuites = []
  let hasForcedToRunSuites = false
  let hasUnskippableSuites = false

  function ciVisEvent (name, testLevel, tags = {}) {
    incrementCountMetric(name, {
      testLevel,
      testFramework: 'cypress',
      isUnsupportedCIProvider,
      ...tags
    })
  }

  function getTestSpan (testName, testSuite, isUnskippable, isForcedToRun) {
    const testSuiteTags = {
      [TEST_COMMAND]: command,
      [TEST_COMMAND]: command,
      [TEST_MODULE]: TEST_FRAMEWORK_NAME
    }
    if (testSuiteSpan) {
      testSuiteTags[TEST_SUITE_ID] = testSuiteSpan.context().toSpanId()
    }
    if (testSessionSpan && testModuleSpan) {
      testSuiteTags[TEST_SESSION_ID] = testSessionSpan.context().toTraceId()
      testSuiteTags[TEST_MODULE_ID] = testModuleSpan.context().toSpanId()
    }

    const {
      childOf,
      resource,
      ...testSpanMetadata
    } = getTestSpanMetadata(tracer, testName, testSuite, config)

    const codeOwners = getCodeOwnersForFilename(testSuite, codeOwnersEntries)

    if (codeOwners) {
      testSpanMetadata[TEST_CODE_OWNERS] = codeOwners
    }

    if (isUnskippable) {
      hasUnskippableSuites = true
      incrementCountMetric(TELEMETRY_ITR_UNSKIPPABLE, { testLevel: 'suite' })
      testSpanMetadata[TEST_ITR_UNSKIPPABLE] = 'true'
    }

    if (isForcedToRun) {
      hasForcedToRunSuites = true
      incrementCountMetric(TELEMETRY_ITR_FORCED_TO_RUN, { testLevel: 'suite' })
      testSpanMetadata[TEST_ITR_FORCED_RUN] = 'true'
    }

    ciVisEvent(TELEMETRY_EVENT_CREATED, 'test', { hasCodeOwners: !!codeOwners })

    return tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test`, {
      childOf,
      tags: {
        [COMPONENT]: TEST_FRAMEWORK_NAME,
        [ORIGIN_KEY]: CI_APP_ORIGIN,
        ...testSpanMetadata,
        ...testEnvironmentMetadata,
        ...testSuiteTags
      }
    })
  }

  on('before:run', (details) => {
    return getLibraryConfiguration(tracer, testConfiguration).then(({ err, libraryConfig }) => {
      if (err) {
        log.error(err)
      } else {
        isSuitesSkippingEnabled = libraryConfig.isSuitesSkippingEnabled
        isCodeCoverageEnabled = libraryConfig.isCodeCoverageEnabled
      }

      return getSkippableTests(isSuitesSkippingEnabled, tracer, testConfiguration)
        .then(({ err, skippableTests, correlationId }) => {
          if (err) {
            log.error(err)
          } else {
            testsToSkip = skippableTests || []
            itrCorrelationId = correlationId
          }

          // `details.specs` are test files
          details.specs.forEach(({ absolute, relative }) => {
            const isUnskippableSuite = isMarkedAsUnskippable({ path: absolute })
            if (isUnskippableSuite) {
              unskippableSuites.push(relative)
            }
          })

          const childOf = getTestParentSpan(tracer)
          rootDir = getRootDir(details)

          command = getCypressCommand(details)
          frameworkVersion = getCypressVersion(details)

          const testSessionSpanMetadata = getTestSessionCommonTags(command, frameworkVersion, TEST_FRAMEWORK_NAME)
          const testModuleSpanMetadata = getTestModuleCommonTags(command, frameworkVersion, TEST_FRAMEWORK_NAME)

          testSessionSpan = tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test_session`, {
            childOf,
            tags: {
              [COMPONENT]: TEST_FRAMEWORK_NAME,
              ...testEnvironmentMetadata,
              ...testSessionSpanMetadata
            }
          })
          ciVisEvent(TELEMETRY_EVENT_CREATED, 'session')

          testModuleSpan = tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test_module`, {
            childOf: testSessionSpan,
            tags: {
              [COMPONENT]: TEST_FRAMEWORK_NAME,
              ...testEnvironmentMetadata,
              ...testModuleSpanMetadata
            }
          })
          ciVisEvent(TELEMETRY_EVENT_CREATED, 'module')

          return details
        })
    })
  })
  on('after:spec', (spec, { tests, stats }) => {
    const cypressTests = tests || []
    const finishedTests = finishedTestsByFile[spec.relative] || []

    // Get tests that didn't go through `dd:afterEach`
    // and create a skipped test span for each of them
    cypressTests.filter(({ title }) => {
      const cypressTestName = title.join(' ')
      const isTestFinished = finishedTests.find(({ testName }) => cypressTestName === testName)

      return !isTestFinished
    }).forEach(({ title }) => {
      const cypressTestName = title.join(' ')
      const isSkippedByItr = testsToSkip.find(test =>
        cypressTestName === test.name && spec.relative === test.suite
      )
      const skippedTestSpan = getTestSpan(cypressTestName, spec.relative)
      skippedTestSpan.setTag(TEST_STATUS, 'skip')
      if (isSkippedByItr) {
        skippedTestSpan.setTag(TEST_SKIPPED_BY_ITR, 'true')
      }
      if (itrCorrelationId) {
        skippedTestSpan.setTag(ITR_CORRELATION_ID, itrCorrelationId)
      }
      skippedTestSpan.finish()
    })

    // Make sure that reported test statuses are the same as Cypress reports.
    // This is not always the case, such as when an `after` hook fails:
    // Cypress will report the last run test as failed, but we don't know that yet at `dd:afterEach`
    let latestError
    finishedTests.forEach((finishedTest) => {
      const cypressTest = cypressTests.find(test => test.title.join(' ') === finishedTest.testName)
      if (!cypressTest) {
        return
      }
      if (cypressTest.displayError) {
        latestError = new Error(cypressTest.displayError)
      }
      const cypressTestStatus = CYPRESS_STATUS_TO_TEST_STATUS[cypressTest.state]
      // update test status
      if (cypressTestStatus !== finishedTest.testStatus) {
        finishedTest.testSpan.setTag(TEST_STATUS, cypressTestStatus)
        finishedTest.testSpan.setTag('error', latestError)
      }
      if (itrCorrelationId) {
        finishedTest.testSpan.setTag(ITR_CORRELATION_ID, itrCorrelationId)
      }
      finishedTest.testSpan.finish(finishedTest.finishTime)
    })

    if (testSuiteSpan) {
      const status = getSuiteStatus(stats)
      testSuiteSpan.setTag(TEST_STATUS, status)

      if (latestError) {
        testSuiteSpan.setTag('error', latestError)
      }
      testSuiteSpan.finish()
      testSuiteSpan = null
      ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
    }
  })

  on('after:run', (suiteStats) => {
    if (testSessionSpan && testModuleSpan) {
      const testStatus = getSessionStatus(suiteStats)
      testModuleSpan.setTag(TEST_STATUS, testStatus)
      testSessionSpan.setTag(TEST_STATUS, testStatus)

      addIntelligentTestRunnerSpanTags(
        testSessionSpan,
        testModuleSpan,
        {
          isSuitesSkipped: isTestsSkipped,
          isSuitesSkippingEnabled,
          isCodeCoverageEnabled,
          skippingType: 'test',
          skippingCount: skippedTests.length,
          hasForcedToRunSuites,
          hasUnskippableSuites
        }
      )

      testModuleSpan.finish()
      ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
      testSessionSpan.finish()
      ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')

      finishAllTraceSpans(testSessionSpan)
    }

    return new Promise(resolve => {
      const exporter = tracer._tracer._exporter
      if (!exporter) {
        return resolve(null)
      }
      if (exporter.flush) {
        exporter.flush(() => {
          appClosingTelemetry()
          resolve(null)
        })
      } else if (exporter._writer) {
        exporter._writer.flush(() => {
          appClosingTelemetry()
          resolve(null)
        })
      }
    })
  })
  on('task', {
    'dd:testSuiteStart': (suite) => {
      if (testSuiteSpan) {
        return null
      }
      const testSuiteSpanMetadata = getTestSuiteCommonTags(command, frameworkVersion, suite, TEST_FRAMEWORK_NAME)
      testSuiteSpan = tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test_suite`, {
        childOf: testModuleSpan,
        tags: {
          [COMPONENT]: TEST_FRAMEWORK_NAME,
          ...testEnvironmentMetadata,
          ...testSuiteSpanMetadata
        }
      })
      ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
      return null
    },
    'dd:beforeEach': (test) => {
      const { testName, testSuite } = test
      const shouldSkip = !!testsToSkip.find(test => {
        return testName === test.name && testSuite === test.suite
      })
      const isUnskippable = unskippableSuites.includes(testSuite)
      const isForcedToRun = shouldSkip && isUnskippable

      // skip test
      if (shouldSkip && !isUnskippable) {
        skippedTests.push(test)
        isTestsSkipped = true
        return { shouldSkip: true }
      }

      if (!activeSpan) {
        activeSpan = getTestSpan(testName, testSuite, isUnskippable, isForcedToRun)
      }

      return activeSpan ? { traceId: activeSpan.context().toTraceId() } : {}
    },
    'dd:afterEach': ({ test, coverage }) => {
      const { state, error, isRUMActive, testSourceLine, testSuite, testName } = test
      if (activeSpan) {
        if (coverage && isCodeCoverageEnabled && tracer._tracer._exporter && tracer._tracer._exporter.exportCoverage) {
          const coverageFiles = getCoveredFilenamesFromCoverage(coverage)
          const relativeCoverageFiles = coverageFiles.map(file => getTestSuitePath(file, rootDir))
          if (!relativeCoverageFiles.length) {
            incrementCountMetric(TELEMETRY_CODE_COVERAGE_EMPTY)
          }
          distributionMetric(TELEMETRY_CODE_COVERAGE_NUM_FILES, {}, relativeCoverageFiles.length)
          const { _traceId, _spanId } = testSuiteSpan.context()
          const formattedCoverage = {
            sessionId: _traceId,
            suiteId: _spanId,
            testId: activeSpan.context()._spanId,
            files: relativeCoverageFiles
          }
          tracer._tracer._exporter.exportCoverage(formattedCoverage)
        }
        const testStatus = CYPRESS_STATUS_TO_TEST_STATUS[state]
        activeSpan.setTag(TEST_STATUS, testStatus)

        if (error) {
          activeSpan.setTag('error', error)
        }
        if (isRUMActive) {
          activeSpan.setTag(TEST_IS_RUM_ACTIVE, 'true')
        }
        if (testSourceLine) {
          activeSpan.setTag(TEST_SOURCE_START, testSourceLine)
        }
        const finishedTest = {
          testName,
          testStatus,
          finishTime: activeSpan._getTime(), // we store the finish time here
          testSpan: activeSpan
        }
        if (finishedTestsByFile[testSuite]) {
          finishedTestsByFile[testSuite].push(finishedTest)
        } else {
          finishedTestsByFile[testSuite] = [finishedTest]
        }
        // test spans are finished at after:spec
      }
      activeSpan = null
      ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test')
      return null
    },
    'dd:addTags': (tags) => {
      if (activeSpan) {
        activeSpan.addTags(tags)
      }
      return null
    }
  })
}
