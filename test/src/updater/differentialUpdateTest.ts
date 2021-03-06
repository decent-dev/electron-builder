import BluebirdPromise from "bluebird-lst"
import { GenericServerOptions, WindowsUpdateInfo } from "builder-util-runtime"
import { BLOCK_MAP_FILE_NAME } from "builder-util-runtime/out/blockMapApi"
import { Arch, Platform, Configuration } from "electron-builder"
import { NsisUpdater } from "electron-updater/out/NsisUpdater"
import { close, open, read, readFile, rename, writeFile } from "fs-extra-p"
import { safeLoad } from "js-yaml"
import * as path from "path"
import { TmpDir } from "temp-file"
import { doSpawn } from "builder-util"
import { getBinFromGithub } from "builder-util/out/binDownload"
import { assertPack, removeUnstableProperties } from "../helpers/packTester"
import { createTestApp, tuneNsisUpdater, writeUpdateConfig } from "../helpers/updaterTestUtil"
import { AppImageUpdater } from "electron-updater/out/AppImageUpdater"
import { MacUpdater } from "electron-updater/out/MacUpdater"
import { EventEmitter } from "events"

test.ifAll.ifDevOrWinCi("web installer", async () => {
  process.env.TEST_UPDATER_PLATFORM = "win32"

  let outDirs: Array<string> = []

  async function buildApp(version: string) {
    await assertPack("test-app-one", {
      targets: Platform.WINDOWS.createTarget(["nsis-web"], Arch.x64),
      config: {
        extraMetadata: {
          version,
        },
        // package in any case compressed, customization is explicitly disabled - "do not allow to change compression level to avoid different packages"
        compression: process.env.COMPRESSION as any || "store",
        publish: {
          provider: "s3",
          bucket: "develar",
          path: "test",
        },
      },
    }, {
      signed: true,
      packed: async context => {
        const outDir = context.outDir
        outDirs.push(outDir)
        const targetOutDir = path.join(outDir, "nsis-web")
        const updateInfoFile = path.join(targetOutDir, "latest.yml")

        const updateInfo: WindowsUpdateInfo = safeLoad(await readFile(updateInfoFile, "utf-8"))
        const fd = await open(path.join(targetOutDir, `TestApp-${version}-x64.nsis.7z`), "r")
        try {
          const packageInfo = updateInfo.packages!!.x64
          const buffer = Buffer.allocUnsafe(packageInfo.blockMapSize!!)
          await read(fd, buffer, 0, buffer.length, packageInfo.size - buffer.length)
          const inflateRaw: any = BluebirdPromise.promisify(require("zlib").inflateRaw)
          const blockMapData = (await inflateRaw(buffer)).toString()
          await writeFile(path.join(outDir, "win-unpacked", BLOCK_MAP_FILE_NAME), blockMapData)
        }
        finally {
          await close(fd)
        }
      }
    })
  }

  if (process.env.__SKIP_BUILD == null) {
    await buildApp("1.0.0")

    const tmpDir = new TmpDir()
    try {
      // move dist temporarily out of project dir
      const oldDir = await tmpDir.getTempDir()
      await rename(outDirs[0], oldDir)
      outDirs[0] = oldDir

      await buildApp("1.0.1")
    }
    catch (e) {
      await tmpDir.cleanup()
      throw e
    }

    // move old dist to new project as oldDist - simplify development (no need to guess where old dist located in the temp fs)
    const oldDir = path.join(outDirs[1], "..", "oldDist")
    await rename(outDirs[0], oldDir)
    outDirs[0] = oldDir

    await rename(path.join(oldDir, "nsis-web", "TestApp-1.0.0-x64.nsis.7z"), path.join(oldDir, "win-unpacked", "package.7z"))
  }
  else {
    // to  avoid snapshot mismatch (since in this node app is not packed)
    expect({
      win: [
        {
          file: "latest.yml",
          fileContent: {
            files: [
              {
                sha512: "@sha512",
                url: "Test App ßW Web Setup 1.0.0.exe",
              },
            ],
            packages: {
              x64: {
                blockMapSize: "@blockMapSize",
                headerSize: "@headerSize",
                path: "TestApp-1.0.0-x64.nsis.7z",
                sha512: "@sha512",
                size: "@size",
              },
            },
            path: "Test App ßW Web Setup 1.0.0.exe",
            releaseDate: "@releaseDate",
            sha2: "@sha2",
            sha512: "@sha512",
            version: "1.0.0",
          },
        },
        {
          arch: "x64",
          file: "Test App ßW Web Setup 1.0.0.exe",
          safeArtifactName: "TestApp-WebSetup-1.0.0.exe",
          updateInfo: {
            packages: {
              x64: {
                blockMapSize: "@blockMapSize",
                headerSize: "@headerSize",
                path: "TestApp-1.0.0-x64.nsis.7z",
                sha512: "@sha512",
                size: "@size",
              },
            },
          },
        },
        {
          arch: "x64",
          file: "TestApp-1.0.0-x64.nsis.7z",
        },
      ],
    }).toMatchSnapshot()
    expect({
      win: [
        {
          file: "latest.yml",
          fileContent: {
            files: [
              {
                sha512: "@sha512",
                url: "Test App ßW Web Setup 1.0.1.exe",
              },
            ],
            packages: {
              x64: {
                blockMapSize: "@blockMapSize",
                headerSize: "@headerSize",
                path: "TestApp-1.0.1-x64.nsis.7z",
                sha512: "@sha512",
                size: "@size",
              },
            },
            path: "Test App ßW Web Setup 1.0.1.exe",
            releaseDate: "@releaseDate",
            sha2: "@sha2",
            sha512: "@sha512",
            version: "1.0.1",
          },
        },
        {
          arch: "x64",
          file: "Test App ßW Web Setup 1.0.1.exe",
          safeArtifactName: "TestApp-WebSetup-1.0.1.exe",
          updateInfo: {
            packages: {
              x64: {
                blockMapSize: "@blockMapSize",
                headerSize: "@headerSize",
                path: "TestApp-1.0.1-x64.nsis.7z",
                sha512: "@sha512",
                size: "@size",
              },
            },
          },
        },
        {
          arch: "x64",
          file: "TestApp-1.0.1-x64.nsis.7z",
        },
      ],
    }).toMatchSnapshot()

    outDirs = [
      path.join(process.env.TEST_APP_TMP_DIR!!, "oldDist"),
      path.join(process.env.TEST_APP_TMP_DIR!!, "dist"),
    ]
  }

  await testBlockMap(outDirs[0], path.join(outDirs[1], "nsis-web"), NsisUpdater)
})

async function testLinux(arch: Arch) {
  process.env.TEST_UPDATER_PLATFORM = "linux"
  process.env.TEST_UPDATER_ARCH = Arch[arch]

  const outDirs: Array<string> = []
  await doBuild(outDirs, Platform.LINUX.createTarget(["appimage"], arch))

  process.env.APPIMAGE = path.join(outDirs[0], `TestApp-1.0.0-${arch === Arch.x64 ? "x86_64" : "i386"}.AppImage`)
  await testBlockMap(outDirs[0], path.join(outDirs[1]), AppImageUpdater)
}

test.ifAll.ifDevOrLinuxCi("AppImage", () => testLinux(Arch.x64))

test.ifAll.ifDevOrLinuxCi("AppImage ia32", () => testLinux(Arch.ia32))

async function buildApp(version: string, outDirs: Array<string>, targets: Map<Platform, Map<Arch, Array<string>>>, extraConfig?: Configuration | null) {
  await assertPack("test-app-one", {
    targets,
    config: {
      extraMetadata: {
        version,
      },
      ...extraConfig,
      compression: "normal",
      publish: {
        provider: "s3",
        bucket: "develar",
        path: "test",
      },
    },
  }, {
    packed: async context => {
      outDirs.push(context.outDir)}
  })
}

async function doBuild(outDirs: Array<string>, targets: Map<Platform, Map<Arch, Array<string>>>, extraConfig?: Configuration | null) {
  await buildApp("1.0.0", outDirs, targets, extraConfig)

  const tmpDir = new TmpDir()
  try {
    // move dist temporarily out of project dir
    const oldDir = await tmpDir.getTempDir()
    await rename(outDirs[0], oldDir)
    outDirs[0] = oldDir

    await buildApp("1.0.1", outDirs, targets, extraConfig)
  }
  catch (e) {
    await tmpDir.cleanup()
    throw e
  }

  // move old dist to new project as oldDist - simplify development (no need to guess where old dist located in the temp fs)
  const oldDir = path.join(outDirs[1], "..", "oldDist")
  await rename(outDirs[0], oldDir)
  outDirs[0] = oldDir
}

test.ifAll.ifMac.ifNotCi("dmg", async () => {
  process.env.TEST_UPDATER_PLATFORM = "darwin"

  const outDirs: Array<string> = []
  if (process.env.__SKIP_BUILD == null) {
    await doBuild(outDirs, Platform.MAC.createTarget(), {
      mac: {
        electronUpdaterCompatibility: ">=2.17.0",
      },
    })
  }
  else {
    // todo
  }

  await testBlockMap(outDirs[0], path.join(outDirs[1]), MacUpdater)
})

async function checkResult(updater: NsisUpdater) {
  const updateCheckResult = await updater.checkForUpdates()
  const downloadPromise = updateCheckResult.downloadPromise
  expect(downloadPromise).not.toBeNull()
  const files = await downloadPromise
  const fileInfo: any = updateCheckResult.updateInfo.files[0]

  // because port is random
  expect(fileInfo.url).toBeDefined()
  delete fileInfo.url
  expect(removeUnstableProperties(updateCheckResult.updateInfo)).toMatchSnapshot()
  expect(files!!.map(it => path.basename(it))).toMatchSnapshot()
}

class TestNativeUpdater extends EventEmitter {
  // private updateUrl: string | null = null

  // noinspection JSMethodCanBeStatic
  checkForUpdates() {
    console.log("TestNativeUpdater.checkForUpdates")
    // this.download()
    //   .catch(error => {
    //     this.emit("error", error)
    //   })
  }

  // private async download() {
  // }

  // noinspection JSMethodCanBeStatic
  setFeedURL(updateUrl: string) {
    // console.log("TestNativeUpdater.setFeedURL " + updateUrl)
    // this.updateUrl = updateUrl
  }
}

async function testBlockMap(oldDir: string, newDir: string, updaterClass: any) {
  const port = 8000 + updaterClass.name.charCodeAt(0)

  // noinspection SpellCheckingInspection
  const httpServerProcess = doSpawn(path.join(await getBinFromGithub("ran", "0.1.3", "imfA3LtT6umMM0BuQ29MgO3CJ9uleN5zRBi3sXzcTbMOeYZ6SQeN7eKr3kXZikKnVOIwbH+DDO43wkiR/qTdkg=="), process.platform, "ran"), [`-root=${newDir}`, `-port=${port}`])
  {
    (process as any).resourcesPath = path.join(oldDir, "win-unpacked", "resources")
  }

  const mockNativeUpdater = new TestNativeUpdater()
  const mockApp = createTestApp("0.0.1")
  jest.mock("electron", () => {
    return {
      app: mockApp,
      autoUpdater: mockNativeUpdater,
    }
  }, {virtual: true})

  return await new BluebirdPromise((resolve, reject) => {
    httpServerProcess.on("error", reject)

    const updater = new updaterClass()
    tuneNsisUpdater(updater)
    updater.logger = console
    const doTest = async () => {
      updater.updateConfigPath = await writeUpdateConfig<GenericServerOptions>({
        provider: "generic",
        url: `http://127.0.0.1:${port}`,
      })

      await checkResult(updater)
    }

    doTest()
      .then(() => resolve())
      .catch(reject)
  })
    .finally(() => {
      httpServerProcess.kill()
    })
}