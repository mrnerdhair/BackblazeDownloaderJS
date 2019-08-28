/* jshint esnext: true, noyield: true, node: true */
"use strict";

let request = require("request");
let BZFTPTransform = require("./bzftptransform");
let fs = require("fs");

process.on("message", function(options){
    let writeStream = fs.createWriteStream(options.tempFilePath);
    if (!writeStream) {
        process.send({ done: false, error: new Error("could not open write stream") });
    } else {
        request(options.requestOptions).pipe(new BZFTPTransform()).pipe(writeStream).on("error", function (err) {
            writeStream.end();
            process.send({ done: false, error: err });
        }).on("finish", function () {
            writeStream.end();
            process.send({ done: true });
        });
    }
});

process.on("disconnect", function () {
    process.exit();
});
