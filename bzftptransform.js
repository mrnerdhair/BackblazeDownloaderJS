/* jshint esnext: true, noyield: true, node: true */
"use strict";

let stream = require("stream");
let crypto = require("crypto");

module.exports = function(){
    let transform = new stream.Transform();
    transform.hash = crypto.createHash("sha1");
    transform.header = Buffer.from([]);
    transform.footer = Buffer.from([]);
    transform._transform = function (chunk, encoding, done){
        try {
            if (encoding !== "buffer") throw new Error("Expected encoding type to be 'buffer'");

            let startIndex = 0;
            while (this.header.length < 0x18 && startIndex < chunk.length) {
                this.header = Buffer.concat([this.header, Buffer.from([chunk[startIndex]])], this.header.length + 1);
                startIndex++;
            }

            if (this.header.length >= 0x18) {
                if (!this.header.equals(Buffer.from("bzftp001t_aaaaaabzftp002", "utf8"))) throw new Error("invalid bzftp header");
            }

            this.footer = Buffer.concat([this.footer, chunk.slice(startIndex, chunk.length)], this.footer.length + (chunk.length - startIndex));

            if (this.footer.length > 0x38) {
                let newData = this.footer.slice(0, this.footer.length - 0x38);
                this.footer = this.footer.slice(this.footer.length - 0x38, this.footer.length);

                this.push(newData);
                this.hash.update(newData);
            }

            done();
        } catch (e) { done(e); }
    };
    transform._flush = function (done){
        try {
            if (this.footer.length !== 0x38) throw new Error("stream too short");

            if (!this.footer.slice(0x00, 0x08).equals(Buffer.from("bzftpsha", "utf8")) || !this.footer.slice(0x30, 0x38).equals(Buffer.from("bzftpend", "utf8"))) throw new Error("bzftp footer invalid");

            let shaSumString = this.footer.slice(0x08, 0x30).toString("utf8");
            if (!shaSumString || !(new RegExp("^[0-9a-f]{40}$").test(shaSumString))) throw new Error("bzftp shasum in invalid format: " + shaSumString);

            let shaSum = this.hash.digest("hex");

            if (shaSumString !== shaSum) throw Error("bzftp shasum invalid");

            done();
        } catch (e) { done(e); }
    };

    return transform;
}