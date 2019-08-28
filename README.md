# BackblazeDownloaderJS

Way back in 2016 my system crashed hard and I was left needing to restore some terabytes of data from Backblaze over my then-gigabit connection. Unfortunately, their download utility presented some problems. First, it was Windows-only; second, it spawned a new process for every (fixed-size) chunk it downloaded, and because we're talking Windows processes the overhead of opening and closing processes that fast quickly became the bottleneck. IIRC, I only got something like 100Mbps down using their utility.

I got impatient, and so after performing some basic protocol analysis and [getting a little help](https://reverseengineering.stackexchange.com/questions/12193/backblaze-16-bit-checksum-bzsanity), I wrote this utility to download all the things at all the speed. I then promptly forgot about it, until [someone](https://reverseengineering.stackexchange.com/questions/12193/backblaze-16-bit-checksum-bzsanity#comment35275_12193) poked me with a stick.

# Caveat Emptor

- This is old code. It still works for me, but my test was only about 300MB, so YMMV.
- Part of the point here was as a practical excercise to use while I taught myself Node.js. Mistakes and inelegancies are my own, and hopefully understandable given the context. Specifically, documentation is sparse, there are no test cases, and this isn't something I'd consider production-quality code in this form.
- This is from the bad old pre-Harmony days of Node.js. No native Promises or async/await keywords, for example; just a lot of Bluebird coroutines and `yield` statements.
- `package-lock.json` wasn't a thing when I created this; luckily, I still had my old `node_modules` directory, and used a modern version of `npm` to make a lockfile matching all the old versions I was using when the thing actually worked for me.
- No warranty, express or implied, yadda yadda. At this point, any usage beyond the academic is at your own risk. Specifically, if Backblaze doesn't like the load this puts on their servers, that's between you and them.
- This is all hereby licensed as [SPDX:BSD-3-Clause](https://opensource.org/licenses/BSD-3-Clause). Specifically, if anyone at Backblaze finds this useful, more power to you.

# Usage

`npm start` should be good enough. You'll get prompts for username, password, etcetera. You'll also be asked to choose from a list of downloadable restore files. All the prompted-for options are also taken as command-line arguments, in the order they're asked for, which can be useful if you need to kill the process and resume later. Files are downloaded to `process.cwd()`, so start it from the directory you want the files to go to.

You'll get stats periodically (specifically, after every N chunks, where N is the number of simultaneous downloads). If your restore is assigned to a server cluster via DNS-round-robin, the download streams will be spread evenly among all the server IPs. There's a `+` printed to the screen each time a chunk starts downloading, and a `-` each time one finishes, for a progress-bar-ish effect.

There is a bug I never got around to fixing: the process does not exit when it's done. I never bothered to fix it, because you can always Ctrl-C out at the end of the process.

# Contributions

Yes, please! With your help, there might even come a day when this project doesn't have a bunch of code-quality disclaimers.
