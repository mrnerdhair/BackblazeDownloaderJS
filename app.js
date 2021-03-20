/* jshint esnext: true, noyield: true, node: true */
"use strict";
let Bluebird = require("bluebird");
Bluebird.config({ cancellation: true });
Bluebird.coroutine(function*(emailAddress, password, twoFactorCode, restoreIndex, numStreams, blockSize){
    // Imports
    let readline = require("readline");
    let requestPromise = require("request-promise");
    let xml2js = Bluebird.promisifyAll(require("xml2js"));
    let _ = require("lodash");
    let moment = require("moment");
    let fs = Bluebird.promisifyAll(require("fs"));
    let path = require("path");
    let http = require("http");
    let temp = Bluebird.promisifyAll(require("temp")).track();
    let sha1 = require("sha1");
    let filesize = require("filesize");
    let childProcess = require("child_process");
    let dns = Bluebird.promisifyAll(require("dns"));
    let request = require("request");
    let BZFTPTransform = require("./bzftptransform");

    let useChildProcesses = false;

    let readConsole = readline.createInterface({ input: process.stdin, output: process.stdout });
    let questionAsync = function (prompt){
        return new Bluebird(function (resolve, reject) {
            readConsole.question(prompt, resolve);
        });
    };

    let emailRegex = new RegExp("^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$", "i");

    if (!emailAddress) emailAddress = yield questionAsync("Backblaze Email Address: ");
    if (!emailRegex.test(emailAddress)) {
        console.error("Invalid email address!");
        return;
    }

    if (!password) password = yield questionAsync("Backblaze Password: ");
    if (password == null || password.length == 0) {
        console.error("Password empty!");
        return;
    }

    if (!twoFactorCode) twoFactorCode = yield questionAsync("2FA Code: [none] ");
    if (twoFactorCode == null || twoFactorCode.length == 0) twoFactorCode = "none";
    if (twoFactorCode != "none" && twoFactorCode.length != 6) {
        console.error("Invalid 2FA Code!");
        return;
    }

    console.log("Logging in...");

    let emailHex = Buffer.from(emailAddress, "utf8").toString("hex");
    let pwHex = Buffer.from(password, "utf8").toString("hex");
    let bzSanity = sha1(emailHex);
    bzSanity = bzSanity[1] + bzSanity[3] + bzSanity[5] + bzSanity[7];
    let result = yield requestPromise.post({
        url: "https://ca001.backblaze.com/api/restoreinfo",
        formData: {
            "version": "4.0.4.903",
            "hexemailaddr": emailHex,
            "hexpassword": pwHex,
            "twofactorverifycode": twoFactorCode,
            "bz_auth_token": "none",
            "bzsanity": bzSanity,
            "bzpostp": {
                value: Buffer.from("dummy", "utf8"),
                options: {
                    filename: "bzdatap.zip",
                    contentType: "binary"
                }
            }
        },
        strictSSL: false
    });
    if (!result) {
        console.error("Could not get login response!");
        return;
    }

    let resultDoc = yield xml2js.parseStringAsync(result);
    if (!resultDoc || !resultDoc.content || !resultDoc.content.response || resultDoc.content.response.length != 1) {
        console.error("Login returned invalid XML!", resultDoc, resultDoc.response);
        return;
    }

    let resultContent = resultDoc.content;
    if (resultContent.response[0].$.result !== "true") {
        console.error("Login failed! Reason:", resultContent.response[0].$.reason);
        return;
    }
    if (!resultContent.restore) {
        console.error("No restores listed!");
        return;
    }

    let restoreFiles = _.filter(resultContent.restore, function(x){ return x.$["type"] === "file" && x.$["restore_in_progress"] === "false"; });

    if (!restoreFiles || restoreFiles.length == 0) {
        console.error("No restore files avaliable to download!");
        return;
    }

    if (!restoreIndex) {
        console.log("Avaliable restore files:");
        for (let i = 0; i < restoreFiles.length; i++) {
            let restore = restoreFiles[i];
            console.log((i + 1) + ": " + restore.$["display_filename"] + " (" + restore.$["host"] + ": " + moment(new Date(parseInt(restore.$["date"]))).format("M/D/YYYY h:mm a") + ", " + filesize(restore.$["size"]) + ")");
        }
        restoreIndex = yield questionAsync("Which restore? [1] ");
    }
    if (restoreIndex == null || restoreIndex.length == 0) restoreIndex = "1";
    restoreIndex = parseInt(restoreIndex);
    if (isNaN(restoreIndex) || restoreIndex < 1 || restoreIndex > restoreFiles.length) {
        console.error("Bad restore index!");
        return;
    }

    let restore = restoreFiles[restoreIndex - 1];
    let restoreSize = parseInt(restore.$["zipsize"]);
    if (isNaN(restoreSize) || restoreSize <= 0) {
        console.error("Invalid restore file size!");
        return;
    }

    console.log("Selected " + restore.$["display_filename"] + ".");

    let restoreTmpFilePath = path.join(process.cwd(), restore.$["display_filename"] + "_downloading.bztmp");
    let restoreRealFilePath = path.join(process.cwd(), restore.$["display_filename"]);

    let fullFileExists = fs.existsSync(restoreRealFilePath);
    if (fullFileExists) {
        console.error("Downloaded file already exists!")
        return;
    }

    let fileExists = fs.existsSync(restoreTmpFilePath);

    let completeBytes = 0;
    if (fileExists) {
        let restoreTmpFileStats = yield fs.statAsync(restoreTmpFilePath);
        if (restoreTmpFileStats.size % (1 * 1024 * 1024) != 0) {
            console.error("Temp file size should be a multiple of 1 MiB:", restoreTmpFileStats.size);
            return;
        }
        completeBytes = restoreTmpFileStats.size;
    }
    let startingCompleteBytes = completeBytes;
    let lastCompleteBytes = completeBytes;

    let hostName = restore.$["serverhost"] + ".backblaze.com";
    let dnsAddresses = yield dns.resolveAsync(hostName);
    console.log("Downloading from " + hostName + " (" + dnsAddresses.length + " IPs)");

    let fileStream = fs.createWriteStream(restoreTmpFilePath, { flags: "a" });

    if (!numStreams) numStreams = yield questionAsync("Number of download streams: [10] ");
    if (numStreams == null || numStreams.length == 0) numStreams = "10";
    numStreams = parseInt(numStreams);
    if (isNaN(numStreams) || numStreams < 1) {
        console.error("Invalid number of streams!");
        return;
    }

    if (!blockSize) blockSize = yield questionAsync("Block size (MiB): [40] ");
    if (blockSize == null || blockSize.length == 0) blockSize = "40";
    blockSize = parseInt(blockSize);
    if (isNaN(blockSize) || blockSize < 1) {
        console.error("Invalid block size!");
        return;
    }

    console.log("Using %d streams, %d MiB blocks.", numStreams, blockSize);

    blockSize = blockSize * 1024 * 1024;

    let streams = [];
    try {
        yield new Bluebird(Bluebird.coroutine(function*(allStreamsDonePromiseResolver, allStreamsDonePromiseRejector){
            process.on("SIGINT", function(){ allStreamsDonePromiseRejector("Caught SIGINT"); });

            let numStreamsSpawned = 0;
            let numStreamsInFlight = 0;
            let newDownloadStreamMutex = Bluebird.resolve();
            let newDownloadStream = function () { return newDownloadStreamMutex = newDownloadStreamMutex.then(function () { return newDownloadStreamRaw(); }).catch(allStreamsDonePromiseRejector); };
            let newDownloadStreamRaw = Bluebird.coroutine(function*() {
                let pendingBytes = _.reduce(_.map(streams, function (x) { return x.numBytes; }), _.add, 0);
                if (completeBytes + pendingBytes >= restoreSize) return;
                //console.log("%d+%d<%d", completeBytes, pendingBytes, restoreSize);

                let startByteIndex = completeBytes + pendingBytes;
                let numBytes = (startByteIndex + blockSize > restoreSize ? restoreSize - startByteIndex : blockSize)

                let tempInfo = yield temp.openAsync("bztemp_");
                yield fs.closeAsync(tempInfo.fd);

                let streamInfo = {};
                streamInfo.tempFilePath = tempInfo.path;
                streamInfo.done = false;
                streamInfo.startByteIndex = startByteIndex;
                streamInfo.numBytes = numBytes
                streamInfo.startMoment = moment();
                streamInfo.streamNum = numStreamsSpawned;


                let downloadOptions = {
                    tempFilePath: streamInfo.tempFilePath,
                    requestOptions: {
                        url: "https://" + dnsAddresses[numStreamsSpawned % dnsAddresses.length] + "/api/restorezipdownloadex",
                        headers: [
                            {
                                name: "Host",
                                value: hostName
                            }
                        ],
                        method: "POST",
                        formData: {
                            "version": "4.0.4.903",
                            "hexemailaddr": emailHex,
                            "hexpassword": pwHex,
                            "twofactorverifycode": twoFactorCode,
                            "bz_auth_token": "none",
                            "bzsanity": bzSanity,
                            "hguid": restore.$["hguid"],
                            "rid": restore.$["rid"],
                            "request_firstbyteindex": startByteIndex,
                            "request_numbytes": numBytes,
                            "bzpostp": {
                                value: "dummy",
                                options: {
                                    filename: "bzdatap.zip",
                                    contentType: "binary"
                                }
                            }
                        },
                        strictSSL: false
                    }
                };

                if (useChildProcesses) {
                    streamInfo.downloadPromise = new Bluebird(function (resolve, reject, onCancel) {
                        streamInfo.child = childProcess.fork(path.join(__dirname, "./bzdownthread.js"));
                        onCancel(function(){ streamInfo.child.disconnect(); streamInfo.child.kill(); });
                        streamInfo.child.on("message", function(msg){
                            streamInfo.child.disconnect();

                            if (msg.done) {
                                resolve();
                            } else {
                                reject(msg.error);
                            }
                        });
                        streamInfo.child.send(requestOptions);
                    });
                } else {
                    streamInfo.downloadPromise = new Bluebird(function (resolve, reject, onCancel) {
                        let writeStream = fs.createWriteStream(downloadOptions.tempFilePath);
                        if (!writeStream) {
                           reject(new Error("could not open write stream"));
                        } else {
                            let downloadStream = request(downloadOptions.requestOptions).pipe(new BZFTPTransform()).pipe(writeStream).on("error", function (err) {
                                writeStream.end();
                                reject(err);
                            }).on("finish", function () {
                                writeStream.end();
                                resolve();
                            });

                            onCancel(function(){ writeStream.end(); downloadStream.end(); });
                        }
                    });
                }

                streamInfo.downloadPromise.then(function(){
                    streamInfo.networkMbps = ((streamInfo.numBytes / (1024 * 1024)) / (moment().diff(streamInfo.startMoment, "milliseconds"))) * 1000 * 8;
                    streamInfo.done = true;

                    if (numStreamsInFlight < numStreams * 5) newDownloadStream();
                    streamCleanup();
                }).catch(function(err){
                    allStreamsDonePromiseRejector(new Error("Error in download worker for stream " + streamInfo.streamNum + ":" + err));
                });

                numStreamsSpawned++;
                numStreamsInFlight++;

                streams.push(streamInfo);
                process.stdout.write("+");
            });

            streams.showStats = function () {
                let currentMbps = (((completeBytes - lastCompleteBytes) / (1024 * 1024)) / (moment().diff(lastMoment, "milliseconds"))) * 1000 * 8;
                let totalMbps = (((completeBytes - startingCompleteBytes) / (1024 * 1024)) / (moment().diff(startMoment, "milliseconds"))) * 1000 * 8;

                let mbitsLeft = ((restoreSize - completeBytes) / (1024 * 1024)) * 8;

                process.stdout.write("\n");
                console.log(filesize(completeBytes) + " / " + filesize(restoreSize) + " (" + currentMbps.toFixed(2) + " Mbps instantaneous, " + totalMbps.toFixed(2) + " Mbps total, ETA: " + moment.duration(mbitsLeft / totalMbps, "seconds").humanize() + ")");

                lastCompleteBytes = completeBytes;
                lastMoment = moment();
            };

            let numStreamsRetired = 0;
            let streamCleanupMutex = Bluebird.resolve();
            let streamCleanup = function () { return streamCleanupMutex = streamCleanupMutex.then(function () { return streamCleanupRaw(); }).catch(allStreamsDonePromiseRejector); };
            let streamCleanupRaw = Bluebird.coroutine(function*() {
                if (streams.length == 0) {
                    allStreamsDonePromiseResolver();
                    return;
                }

                if (streams.length > 0 && streams[0].done) {
                    let stream = streams[0];
                    streams.splice(0, 1);
                    completeBytes += stream.numBytes;

                    numStreamsRetired++;
                    let shouldShowStats = (numStreamsRetired % numStreams === 0);

                    //process.stdout.write("\n");
                    //console.log("Writing stream %d (%d bytes at offest %d)...", stream.streamNum, stream.numBytes, stream.startByteIndex);

                    yield new Bluebird(function (resolve, reject) {
                        fs.createReadStream(stream.tempFilePath).on("error", reject).on("end", resolve).pipe(fileStream, { end: false });
                    });

                    yield fs.unlinkAsync(stream.tempFilePath);
                    process.stdout.write("-");

                    //process.stdout.write("\n");
                    //console.log("Done writing stream %d.", stream.streamNum);

                    if (shouldShowStats) streams.showStats();

                    numStreamsInFlight--;
                    for (let i = numStreamsInFlight; i < numStreams; i++) newDownloadStream();

                    streamCleanup();
                }
            });

            console.log("Starting download...");
            let startMoment = moment();
            let lastMoment = startMoment;
            for (let i = 0; i < numStreams; i++) yield newDownloadStream();
        }));
    } catch (e) {
        for (let stream of streams) {
            stream.downloadPromise.cancel();
        }

        process.stdout.write("\n");
        throw e;
    }

    streams.showStats();
    console.log("Download done, moving file...");

    fileStream.end();
    yield fs.renameAsync(restoreTmpFilePath, restoreRealFilePath);

    console.log("Download complete!");
    process.exit(0);
})(process.argv[2], process.argv[3], process.argv[4], process.argv[5], process.argv[6], process.argv[7]).done();