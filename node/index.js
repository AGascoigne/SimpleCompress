// Node version of the .Net simple compress app

var fs = require('fs');
var zlib = require('zlib');
var path = require('path');
var crypto = require('crypto')

var args = process.argv.slice(2);
if (args.length != 3) { ShowUsageAndExit(); }

var src = path.resolve(args[1]);
var dst = path.resolve(args[2]);

// Only need to check this once
var isWin = /^win/.test(process.platform);

switch (args[0]) {
    case "pack":
        Pack(src, dst);
        break;

    case "unpack":
        Unpack(src, dst);
        break;

    default:
        ShowUsageAndExit();
        break;
}
// end of main program
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function ShowUsageAndExit() {
    console.log("Simple Compress\r    Usage:\r        sc pack <src directory> <target file>\r        sc unpack <src file> <target directory>");
    process.exit(1);
}

// recursively scan a directory and pack its contents into an archive
function Pack(src, dst) {
    var temp = dst + '.tmp';
    if (fs.existsSync(temp)) {fs.truncateSync(temp, 0);}

    // build dictionary of equal files
    var parts = {};
    applyToDeepPaths(src, function(p){
        var hash = fileHashSync(p);
        var key = path.basename(p)+'|'+(hash.toString('base64'));
        var subs = p.replace(src,"");
        if (parts[key]) parts[key].paths.push(subs);
        else parts[key] = {paths : [subs], hash : hash};
    });

    // open pack file
    var cat = fs.openSync(temp, 'w');

    // write first data of each dict entry to cat file
    Object.keys(parts).forEach(function(key){
        // Write <MD5:16 bytes>
        WriteBuffer(cat, parts[key].hash, 16);
        // Write <length:8 bytes><paths:utf8 str>
        var paths = parts[key].paths;
        var pathBuffer = new Buffer(paths.join('|'), 'utf8');
        WriteLength(cat, pathBuffer.length);
        fs.writeSync(cat, pathBuffer, 0, pathBuffer.length, null);
        // Write <length:8 bytes><data:byte array>
        var srcFile = path.resolve(path.join(src, paths[0]));
        var fileSize = fs.statSync(srcFile).size;
        WriteLength(cat, fileSize);
        WriteFileData(cat, srcFile);
    });

    // close and gzip the cat file
    fs.close(cat);
    if (fs.existsSync(dst)) {fs.truncateSync(dst, 0);}
    var gzip = zlib.createGzip({level:9});
    var inp = fs.createReadStream(temp);
    var out = fs.createWriteStream(dst);

    console.log('compressing');
    var unzip = inp.pipe(gzip).pipe(out); // unpack into catenated file

    // delete cat file
    unzip.on('finish', function unzipCallback(){
        if (inp.end) inp.end();
        if (out.end) out.end();
        fs.unlinkSync(temp);
        console.log('done');
    });
}

function WriteLength(fd, length){
    var b = new Buffer(8);
    b.writeIntLE(length, 0, 8);
    fs.writeSync(fd, b, 0, 8, null);
}

function WriteBuffer(fd, buf, len) {
    fs.writeSync(fd, buf, 0, len, null);
}

function WriteFileData(dst, fileToAdd){
    var src = fs.openSync(fileToAdd, 'r');
    var buf = new Buffer(65536);

    for (;;){
        var rlen = fs.readSync(src, buf, 0, buf.length, null);
        if (rlen < 1) break;
        fs.writeSync(dst, buf, 0, rlen, null);
    }
    fs.close(src);
}

// run a function against every path under a root path
function applyToDeepPaths(root, functor){
    var exists = fs.existsSync(root);
    var stats = exists && fs.statSync(root); // we will treat symlinks as real things. Pray for no loops
    var isDirectory = exists && stats.isDirectory();
    if (isDirectory) {
        fs.readdirSync(root).forEach(function(childItemName) {
            applyToDeepPaths(path.join(root, childItemName), functor);
        });
    } else if (exists) {
        functor(root);
    }
}

// sync file hash without loading whole file
function fileHashSync(filename){
    var sum = crypto.createHash('md5');
    var fd = fs.openSync(filename, 'r');
    var buf = new Buffer(65536);

    for (;;){
        var rlen = fs.readSync(fd, buf, 0, buf.length, null);
        if (rlen < 1) break;
        sum.update(buf.slice(0, rlen));
    }
    fs.close(fd);
    return sum.digest('base64');
}

// expand an existing package file into a directory structure
function Unpack(src, dst) {
    var temp = src + '.tmp';
    // Unzip archive to temp location
    if (fs.existsSync(temp)) {fs.truncateSync(temp, 0);}
    var gzip = zlib.createGunzip();
    var inp = fs.createReadStream(src);
    var out = fs.createWriteStream(temp);

    console.log('decompressing');
    var unzip = inp.pipe(gzip).pipe(out); // unpack into catenated file

    unzip.on('finish', function unzipCallback(){
        if (inp.end) inp.end();
        if (out.end) out.end();

        console.log('unpacking files');
        unpackCat(temp, dst);
        console.log('done');
    });
}

// then run this over the structure...
// ToDo: see if this can be re-written as a single pipeline

function unpackCat(srcPack, targetPath) {
    var cat = fs.openSync(srcPack, 'r');
    var buf = new Buffer(65536);
    var offset = 0;

    for(;;){
        var hash = ReadHash(cat);
        if (hash == null) {break;}
        var pathLen = ReadLength(cat, buf);
        if (pathLen == 0) {break;}
        var paths = ReadPaths(pathLen, cat, buf);

        // read contents out to all the files at once.
        // The .Net version does a write-then-copy, but Node.js has no OS-level copy.
        var fileLen = ReadLength(cat, buf);
        ReadToFiles(fileLen, paths, targetPath, cat, buf);
    }
    fs.close(cat);
    fs.unlinkSync(srcPack);
}

function ReadHash(fd) {
    var hbuf = new Buffer(16);
    var rlen = fs.readSync(fd, hbuf, 0, 16, null);
    if (rlen == 0) return null; // no more file
    if (rlen !== 16) throw new Error("Malformed file: truncated file set checksum");
    return hbuf;
}

function ReadPaths(len, fd, buffer){
    // todo: handle paths > 64k long
    var rlen = fs.readSync(fd, buffer, 0, len, null);
    if (rlen < 1) throw new Error('Malformed file: Empty path set');
    if (rlen != len) throw new Error("Malformed file: truncated file path list");
    var s = buffer.toString('utf8',0,rlen);
    s = correctFilepath(s);
    return s.split('|');
}

function ReadToFiles(len, paths, target, fd, buffer){
    var remains = len;
    // check directories and truncate files
    for (var i = 0; i < paths.length; i++){
        var npath = path.join(target, paths[i]);
        ensureDirectory(path.dirname(npath));
        if (fs.existsSync(npath)) {fs.truncateSync(npath, 0);}
    }

    // read bytes into files
    while (remains > 0){
        var next = (remains > buffer.length) ? (buffer.length) : (remains);
        var rlen = fs.readSync(fd, buffer, 0, next, null);
        if (rlen < 1) throw new Error('Malformed file: truncated file data');
        remains -= rlen;

        var data = buffer.slice(0, rlen);
        for (var i = 0; i < paths.length; i++){
            var npath = path.join(target, paths[i]);
            fs.appendFileSync(npath, data);
        }
    }
}

function ReadLength(fd, buffer){
    var rlen = fs.readSync(fd, buffer, 0, 8, null);
    if (rlen == 0) return 0; // correct end-of-file
    if (rlen != 8) throw new Error("Malformed file: truncated file segment length");
    return buffer.readIntLE(0, 8); // Node can only support 48 bits of precision, but the file uses 64 bits of data.
}

// node's file system support is shocking
function ensureDirectory (p) {
    p = path.resolve(p);
    try {
        fs.mkdirSync(p);
    } catch (err0) {
        switch (err0.code) {
            case 'ENOENT' :
                ensureDirectory(path.dirname(p));
                ensureDirectory(p);
                break;
            default:
                try {
                    var stat = fs.statSync(p);
                    if (!stat.isDirectory()) throw err0;
                } catch (err1) {
                    throw err0;
                }
                break;
        }
    }
}

/**
 * The compression may have been done on a different os to the current one, so the paths may need to be corrected
 * @param path
 */
function correctFilepath(path) {
    if (isWin) return path.split('/').join('\\');
    else return path.split('\\').join('/');
}
