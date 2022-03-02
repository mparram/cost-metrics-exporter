const prometheus = require('prom-client');
const fs = require("fs");
const path = require("path");
var express = require('express');
const crypto = require('crypto');
var fileupload = require("express-fileupload");
var app = express();
app.listen(8080, function () { 
    console.log('Listening at http://localhost:8080'); 
});
app.use(fileupload());
var filesHash = new Array();
var objOfMetrics = {};
var gracePeriodRunning = false;

// ####################
// options to configure
// ####################
var categorizationLabels = process.env.CAT_LABELS ? process.env.CAT_LABELS : false;
var maxHours = process.env.MAX_HOURS ? process.env.MAX_HOURS : 24;
var maxDays = process.env.MAX_DAYS ? process.env.MAX_DAYS : 30;
var maxMonths = process.env.MAX_MONTHS ? process.env.MAX_MONTHS : 12;
var gracePeriodAtUpload = process.env.GRACE_PERIOD_AT_UPLOAD ? process.env.GRACE_PERIOD_AT_UPLOAD : 10000;
var pvpath = process.env.PV_PATH ? process.env.PV_PATH : '/tmp/costmanagement-metrics-operator-reports/upload';
var pvbckpath = process.env.PV_BCK_PATH ? process.env.PV_BCK_PATH : '/tmp/costmanagement-metrics-operator-reports/metrics-backup';


// register metrics
const register = new prometheus.Registry();
const metricUsageCpuCoreSeconds = new prometheus.Gauge({
    name: 'namespace_usage_cpu_core_seconds',
    help: 'units of cores usaged and seconds aggregated by namespace',
    labelNames: ['interval_type', 'interval_date', 'namespace', 'category_label']
});
const metricRequestCpuCoreSeconds = new prometheus.Gauge({
    name: 'namespace_request_cpu_core_seconds',
    help: 'units of cores requested and seconds aggregated by namespace',
    labelNames: ['interval_type', 'interval_date', 'namespace', 'category_label']
});
const metricLimitCpuCoreSeconds = new prometheus.Gauge({
    name: 'namespace_limit_cpu_core_seconds',
    help: 'units of cores limited and seconds aggregated by namespace',
    labelNames: ['interval_type', 'interval_date', 'namespace', 'category_label']
});
const metricUsageMemoryByteSeconds = new prometheus.Gauge({
    name: 'namespace_usage_memory_byte_seconds',
    help: 'units of memory bytes usaged and seconds aggregated by namespace',
    labelNames: ['interval_type', 'interval_date', 'namespace', 'category_label']
});
const metricRequestMemoryByteSeconds = new prometheus.Gauge({
    name: 'namespace_request_memory_byte_seconds',
    help: 'units of memory bytes requested and seconds aggregated by namespace',
    labelNames: ['interval_type', 'interval_date', 'namespace', 'category_label']
});
const metricLimitMemoryByteSeconds = new prometheus.Gauge({
    name: 'namespace_limit_memory_byte_seconds',
    help: 'units of memory bytes limited and seconds aggregated by namespace',
    labelNames: ['interval_type', 'interval_date', 'namespace', 'category_label']
});
register.registerMetric(metricUsageCpuCoreSeconds);
register.registerMetric(metricRequestCpuCoreSeconds);
register.registerMetric(metricLimitCpuCoreSeconds);
register.registerMetric(metricUsageMemoryByteSeconds);
register.registerMetric(metricRequestMemoryByteSeconds);
register.registerMetric(metricLimitMemoryByteSeconds);

// Load backup data if exists, else go to untar files

if (!fs.existsSync(pvpath)) {
    console.log("folder " + pvpath + " not found, are you sure you have the right path or configured cost-management operator properly?");
    console.log("Be sure to set the same PV with RWX in both");
    console.log(".");
    console.log("exiting...");
    process.exit(1);
}
if (!fs.existsSync(pvbckpath)) {
    console.log("creating backup folder");
    fs.mkdirSync(pvbckpath);
}

fs.mkdirSync("./extracted");

if (fs.existsSync(pvbckpath + '/backup.bck')) {
    loadBackUpData();
} else {
    untarFiles();
}

// for each tar.gz file in folder ./raws, extract content to extracted folder

function untarFilesWithGracePeriod() {
    setTimeout(() => {
        untarFiles();
        gracePeriodRunning = false;
    }
    , gracePeriodAtUpload);
}
fs.watch(pvpath, { recursive: true }, (eventType, filename) => {
    console.log("eventType: " + eventType + " filename: " + filename);
    if ((eventType === 'rename') && (!gracePeriodRunning)) {
        gracePeriodRunning = true;
        untarFilesWithGracePeriod();
    }
});
// workaround because fs.watch is not working with NFS, will check every hour
setInterval(() => {
    untarFilesWithGracePeriod();
}, 3600000);

function untarFiles() {  
    var extractraws = new Promise((resolve, reject) => {

        // Load filesHash of files already extracted
        if (fs.existsSync(pvbckpath + '/filesHash')) {
            var bckHash = fs.readFileSync(pvbckpath + '/filesHash', 'utf8');
            filesHash = bckHash.split('\n');  
        }
        var raws = fs.readdirSync(pvpath);
        raws.forEach((raw, index, array) => {
            // if raw is a tar.gz file
            if (raw.endsWith('.tar.gz')) {
                var rawPath = path.join(pvpath, raw);
                // get hash of rawPath file
                var hash = crypto.createHash('md5').update(rawPath).digest('hex');
                console.log("hash: " + hash);
                // if hash is not in filesHash array, untar file
                if (filesHash.indexOf(hash) === -1) { 
                    var extractedPath = path.join('./extracted', raw.replace('.tar.gz', ''));
                    if (!fs.existsSync(extractedPath)) {
                        fs.mkdirSync(extractedPath);
                    }
                    var tar = require('tar');
                    tar.extract({
                        file: rawPath,
                        cwd: extractedPath
                    }, function(err) {
                        if (err) {
                            console.log(err);
                        } else {
                            console.log('Deleting ' + rawPath);
                            // fs.unlinkSync(rawPath);
                            filesHash.push(hash);
                        }
                    });
                } else {
                    console.log('File already readed (Hash stored): ' + rawPath);
                    // fs.unlinkSync(rawPath);
                }
            }
            if (index === array.length -1) resolve();
        });
        if (raws.length === 0) resolve();
    });
    extractraws.then(() => {
        console.log('Extracted all raws');
        setTimeout(() => {
            readData();
        }, 1000);
    });
    extractraws.catch(err => {
        console.log(err);
    });
}

function loadBackUpData(){
    var loadBackUp = new Promise((resolve, reject) => {
        // load backup/backup.bck to objOfMetrics
        var backupFile = fs.readFileSync(pvbckpath + '/backup.bck', 'utf8');
        backupFile.split('\n').forEach((line, index, array) => {
            if (line.length > 0) {
                var lineArr = line.split(',');
                metricId = lineArr[0];
                metricValue = lineArr[1];
                if (!objOfMetrics[metricId]) objOfMetrics[metricId] = Number(metricValue);
            }
            if (index === array.length -1) resolve();
        });
    });
    loadBackUp.then(() => {
        console.log('loaded backup data');
        setTimeout(() => {
            untarFiles();
        }, 1000);
    });
    loadBackUp.catch(err => {
        console.log(err);
    });
}

function saveBackUpData(){
    // save objOfMetrics to backup/backup.bck
    var backupFile = fs.createWriteStream(pvbckpath + '/backup.bck');
    for (var metricId in objOfMetrics) {
        backupFile.write(metricId + ',' + objOfMetrics[metricId] + '\n');
    }
    backupFile.end();
    var hashFile = fs.createWriteStream(pvbckpath + '/filesHash');
    filesHash.forEach((hash, index, array) => {
        if (hash.length > 0) {
            hashFile.write(hash + '\n');
        }
        if (index === array.length -1) hashFile.end();
    });
}

function aggregateData() {
    // set var currentDate to new Date minus maxHours
    var diffHours = new Date();
    var diffDays = new Date();
    var diffMonths = new Date();
    diffHours.setHours(diffHours.getHours() - maxHours);
    diffDays.setDate(diffDays.getDate() - maxDays);
    diffMonths.setMonth(diffMonths.getMonth() - maxMonths);
    Object.keys(objOfMetrics).forEach((key,index, array) => {
        if (objOfMetrics[key] > 0) {
            var lineData = key.split('|');
            if ((lineData[2] === 'hour') && (new Date(lineData[3]) < diffHours)) {
                // delete objOfMetrics[key] from array
                console.log("purge hour metric: " +  objOfMetrics[key]);
                delete objOfMetrics[key];
            } else if ((lineData[2] === 'day') && (new Date(lineData[3]) < diffDays)) {
                // delete objOfMetrics[key] from array
                delete objOfMetrics[key];
            } else if ((lineData[2] === 'month') && (new Date(lineData[3]) < diffMonths)) {
                // delete objOfMetrics[key] from array
                delete objOfMetrics[key];
            }
        }
    });
    saveBackUpData();
}    

function readData(){
    // for each extracted folder in extracted, read files *.2.csv
    var extracted = fs.readdirSync('./extracted');
    var buildArrays = new Promise((resolve, reject) => {
        if (extracted.length == 0) {
            resolve();
        }
        extracted.forEach((extracted, index, array) => {
            //if extracted is a directory
            if (fs.lstatSync('./extracted/' + extracted).isDirectory()) {
                var extractedPath = path.join('./extracted', extracted);
                var files = fs.readdirSync(extractedPath);
                files.forEach((file, index, array) => {
                    if (file.endsWith('.2.csv')) {
                        var filePath = path.join(extractedPath, file);
                        var data = fs.readFileSync(filePath, 'utf8');
                        var lines = data.split('\n');
                        lines.forEach((line, index, array) => {
                            if ((line.length > 0) && (index > 0) ){
                                var lineData = line.split(',');
                                var currentHour = lineData[2];
                                var currentDay = currentHour.substring(0, 10);
                                var currentMonth = currentDay.substring(0, 7);
                                var podLabels = lineData[18].split('|');
                                var labelValue;
                                podLabels.forEach((podLabel, index, array) => {
                                    // if podLabel start with categorizationLabels in minus, add to objOfMetrics
                                    //convert categorizationLabels to minus chars

                                    if (podLabel.indexOf(categorizationLabels.toLowerCase() + ":") === 0) {
                                        labelValue = podLabel.substring(0,categorizationLabels.length);
                                        console.log("labelValue: " + labelValue);
                                    }
                                });
                                //currentDay = "2022-02-16";
                                //currentMonth = "2022-02";    

                                if (!objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|hour|' + currentHour]) {
                                    objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|hour|' + currentHour] = 0;
                                    objOfMetrics[lineData[5] + '|' + 'metricRequestCpuCoreSeconds' + '|hour|' + currentHour] = 0;
                                    objOfMetrics[lineData[5] + '|' + 'metricLimitCpuCoreSeconds' + '|hour|' + currentHour] = 0;
                                    objOfMetrics[lineData[5] + '|' + 'metricUsageMemoryByteSeconds' + '|hour|' + currentHour] = 0;
                                    objOfMetrics[lineData[5] + '|' + 'metricRequestMemoryByteSeconds' + '|hour|' + currentHour] = 0;
                                    objOfMetrics[lineData[5] + '|' + 'metricLimitMemoryByteSeconds' + '|hour|' + currentHour] = 0;
                                }
                                if (!objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|day|' + currentDay]) {
                                    objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|day|' + currentDay] = 0;
                                    objOfMetrics[lineData[5] + '|' + 'metricRequestCpuCoreSeconds' + '|day|' + currentDay] = 0;
                                    objOfMetrics[lineData[5] + '|' + 'metricLimitCpuCoreSeconds' + '|day|' + currentDay] = 0;
                                    objOfMetrics[lineData[5] + '|' + 'metricUsageMemoryByteSeconds' + '|day|' + currentDay] = 0;
                                    objOfMetrics[lineData[5] + '|' + 'metricRequestMemoryByteSeconds' + '|day|' + currentDay] = 0;
                                    objOfMetrics[lineData[5] + '|' + 'metricLimitMemoryByteSeconds' + '|day|' + currentDay] = 0;
                                }
                                if (!objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|month|' + currentMonth]) {
                                    objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|month|' + currentMonth] = 0;
                                    objOfMetrics[lineData[5] + '|' + 'metricRequestCpuCoreSeconds' + '|month|' + currentMonth] = 0;
                                    objOfMetrics[lineData[5] + '|' + 'metricLimitCpuCoreSeconds' + '|month|' + currentMonth] = 0;
                                    objOfMetrics[lineData[5] + '|' + 'metricUsageMemoryByteSeconds' + '|month|' + currentMonth] = 0;
                                    objOfMetrics[lineData[5] + '|' + 'metricRequestMemoryByteSeconds' + '|month|' + currentMonth] = 0;
                                    objOfMetrics[lineData[5] + '|' + 'metricLimitMemoryByteSeconds' + '|month|' + currentMonth] = 0;
                                }
                                objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|hour|' + currentHour] += Number(lineData[7]);
                                objOfMetrics[lineData[5] + '|' + 'metricRequestCpuCoreSeconds' + '|hour|' + currentHour] += Number(lineData[8]);
                                objOfMetrics[lineData[5] + '|' + 'metricLimitCpuCoreSeconds' + '|hour|' + currentHour] += Number(lineData[9]);
                                objOfMetrics[lineData[5] + '|' + 'metricUsageMemoryByteSeconds' + '|hour|' + currentHour] += Number(lineData[10]);
                                objOfMetrics[lineData[5] + '|' + 'metricRequestMemoryByteSeconds' + '|hour|' + currentHour] += Number(lineData[11]);
                                objOfMetrics[lineData[5] + '|' + 'metricLimitMemoryByteSeconds' + '|hour|' + currentHour] += Number(lineData[12]);
                                objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|day|' + currentDay] += Number(lineData[7]);
                                objOfMetrics[lineData[5] + '|' + 'metricRequestCpuCoreSeconds' + '|day|' + currentDay] += Number(lineData[8]);
                                objOfMetrics[lineData[5] + '|' + 'metricLimitCpuCoreSeconds' + '|day|' + currentDay] += Number(lineData[9]);
                                objOfMetrics[lineData[5] + '|' + 'metricUsageMemoryByteSeconds' + '|day|' + currentDay] += Number(lineData[10]);
                                objOfMetrics[lineData[5] + '|' + 'metricRequestMemoryByteSeconds' + '|day|' + currentDay] += Number(lineData[11]);
                                objOfMetrics[lineData[5] + '|' + 'metricLimitMemoryByteSeconds' + '|day|' + currentDay] += Number(lineData[12]);
                                objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|month|' + currentMonth] += Number(lineData[7]);
                                objOfMetrics[lineData[5] + '|' + 'metricRequestCpuCoreSeconds' + '|month|' + currentMonth] += Number(lineData[8]);
                                objOfMetrics[lineData[5] + '|' + 'metricLimitCpuCoreSeconds' + '|month|' + currentMonth] += Number(lineData[9]);
                                objOfMetrics[lineData[5] + '|' + 'metricUsageMemoryByteSeconds' + '|month|' + currentMonth] += Number(lineData[10]);
                                objOfMetrics[lineData[5] + '|' + 'metricRequestMemoryByteSeconds' + '|month|' + currentMonth] += Number(lineData[11]);
                                objOfMetrics[lineData[5] + '|' + 'metricLimitMemoryByteSeconds' + '|month|' + currentMonth] += Number(lineData[12]);

                                if (labelValue !== "") {
                                    if (!objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|hour|' + currentHour + "|" + categorizationLabels + "|" + labelValue]) {
                                        objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|hour|' + currentHour + "|" + categorizationLabels + "|" + labelValue] = 0;
                                        objOfMetrics[lineData[5] + '|' + 'metricRequestCpuCoreSeconds' + '|hour|' + currentHour + "|" + categorizationLabels + "|" + labelValue] = 0;
                                        objOfMetrics[lineData[5] + '|' + 'metricLimitCpuCoreSeconds' + '|hour|' + currentHour + "|" + categorizationLabels + "|" + labelValue] = 0;
                                        objOfMetrics[lineData[5] + '|' + 'metricUsageMemoryByteSeconds' + '|hour|' + currentHour + "|" + categorizationLabels + "|" + labelValue] = 0;
                                        objOfMetrics[lineData[5] + '|' + 'metricRequestMemoryByteSeconds' + '|hour|' + currentHour + "|" + categorizationLabels + "|" + labelValue] = 0;
                                        objOfMetrics[lineData[5] + '|' + 'metricLimitMemoryByteSeconds' + '|hour|' + currentHour + "|" + categorizationLabels + "|" + labelValue] = 0;
                                    }
                                    if (!objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|day|' + currentDay + "|" + categorizationLabels + "|" + labelValue]) {
                                        objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|day|' + currentDay + "|" + categorizationLabels + "|" + labelValue] = 0;
                                        objOfMetrics[lineData[5] + '|' + 'metricRequestCpuCoreSeconds' + '|day|' + currentDay + "|" + categorizationLabels + "|" + labelValue] = 0;
                                        objOfMetrics[lineData[5] + '|' + 'metricLimitCpuCoreSeconds' + '|day|' + currentDay + "|" + categorizationLabels + "|" + labelValue] = 0;
                                        objOfMetrics[lineData[5] + '|' + 'metricUsageMemoryByteSeconds' + '|day|' + currentDay + "|" + categorizationLabels + "|" + labelValue] = 0;
                                        objOfMetrics[lineData[5] + '|' + 'metricRequestMemoryByteSeconds' + '|day|' + currentDay + "|" + categorizationLabels + "|" + labelValue] = 0;
                                        objOfMetrics[lineData[5] + '|' + 'metricLimitMemoryByteSeconds' + '|day|' + currentDay + "|" + categorizationLabels + "|" + labelValue] = 0;
                                    }
                                    if (!objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|month|' + currentMonth + "|" + categorizationLabels + "|" + labelValue]) {
                                        objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|month|' + currentMonth + "|" + categorizationLabels + "|" + labelValue] = 0;
                                        objOfMetrics[lineData[5] + '|' + 'metricRequestCpuCoreSeconds' + '|month|' + currentMonth + "|" + categorizationLabels + "|" + labelValue] = 0;
                                        objOfMetrics[lineData[5] + '|' + 'metricLimitCpuCoreSeconds' + '|month|' + currentMonth + "|" + categorizationLabels + "|" + labelValue] = 0;
                                        objOfMetrics[lineData[5] + '|' + 'metricUsageMemoryByteSeconds' + '|month|' + currentMonth + "|" + categorizationLabels + "|" + labelValue] = 0;
                                        objOfMetrics[lineData[5] + '|' + 'metricRequestMemoryByteSeconds' + '|month|' + currentMonth + "|" + categorizationLabels + "|" + labelValue] = 0;
                                        objOfMetrics[lineData[5] + '|' + 'metricLimitMemoryByteSeconds' + '|month|' + currentMonth + "|" + categorizationLabels + "|" + labelValue] = 0;
                                    }
                                    objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|hour|' + currentHour + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[7]);
                                    objOfMetrics[lineData[5] + '|' + 'metricRequestCpuCoreSeconds' + '|hour|' + currentHour + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[8]);
                                    objOfMetrics[lineData[5] + '|' + 'metricLimitCpuCoreSeconds' + '|hour|' + currentHour + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[9]);
                                    objOfMetrics[lineData[5] + '|' + 'metricUsageMemoryByteSeconds' + '|hour|' + currentHour + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[10]);
                                    objOfMetrics[lineData[5] + '|' + 'metricRequestMemoryByteSeconds' + '|hour|' + currentHour + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[11]);
                                    objOfMetrics[lineData[5] + '|' + 'metricLimitMemoryByteSeconds' + '|hour|' + currentHour + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[12]);
                                    objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|day|' + currentDay + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[7]);
                                    objOfMetrics[lineData[5] + '|' + 'metricRequestCpuCoreSeconds' + '|day|' + currentDay + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[8]);
                                    objOfMetrics[lineData[5] + '|' + 'metricLimitCpuCoreSeconds' + '|day|' + currentDay + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[9]);
                                    objOfMetrics[lineData[5] + '|' + 'metricUsageMemoryByteSeconds' + '|day|' + currentDay + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[10]);
                                    objOfMetrics[lineData[5] + '|' + 'metricRequestMemoryByteSeconds' + '|day|' + currentDay + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[11]);
                                    objOfMetrics[lineData[5] + '|' + 'metricLimitMemoryByteSeconds' + '|day|' + currentDay + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[12]);
                                    objOfMetrics[lineData[5] + '|' + 'metricUsageCpuCoreSeconds' + '|month|' + currentMonth + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[7]);
                                    objOfMetrics[lineData[5] + '|' + 'metricRequestCpuCoreSeconds' + '|month|' + currentMonth + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[8]);
                                    objOfMetrics[lineData[5] + '|' + 'metricLimitCpuCoreSeconds' + '|month|' + currentMonth + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[9]);
                                    objOfMetrics[lineData[5] + '|' + 'metricUsageMemoryByteSeconds' + '|month|' + currentMonth + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[10]);
                                    objOfMetrics[lineData[5] + '|' + 'metricRequestMemoryByteSeconds' + '|month|' + currentMonth + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[11]);
                                    objOfMetrics[lineData[5] + '|' + 'metricLimitMemoryByteSeconds' + '|month|' + currentMonth + "|" + categorizationLabels + "|" + labelValue] += Number(lineData[12]);
                                } 
                            }
                        });
                    }
                });
            }
            if (index === array.length -1) resolve();
        });
    });
    buildArrays.then(() => {
        console.log('Built metrics');
        setTimeout(() => {
            buildMetrics();
        }, 1000);
    });
    buildArrays.catch(err => {
        console.log(err);
    });
}

function buildMetrics(){
    // labelNames: ['interval_type', 'interval_date', 'namespace', 'category_label']
    // for each namespace in nsArr, build metrics
    var metricsArr = [];
    var fillMetrics = new Promise((resolve, reject) => {
        Object.keys(objOfMetrics).forEach((key,index, array) => {
            var lineData = key.split('|');
            if (lineData[5]) {
                eval(lineData[1]).set({ interval_type: lineData[2], interval_date: lineData[3], namespace: lineData[0], category_label: lineData[5]}, Number(objOfMetrics[key]));
            } else {
                eval(lineData[1]).set({ interval_type: lineData[2], interval_date: lineData[3], namespace: lineData[0]}, Number(objOfMetrics[key]));
            }
            if (index === array.length -1) resolve();
        });
    });
    fillMetrics.then(() => {
        console.log('Built metrics');
        aggregateData();
        // delete all folders in ./extracted/*
        var deleteFolders = new Promise((resolve, reject) => {
            fs.readdir('./extracted', (err, folders) => {
                if (err) {
                    console.log(err);
                    reject(err);
                }
                folders.forEach((folder, index, array) => {
                    //if folder if a folder, delete it
                    if (fs.lstatSync('./extracted/' + folder).isDirectory()) {
                        fs.rmdirSync('./extracted/' + folder, { recursive: true, force: true });
                    }
                    if (index === array.length -1) resolve();
                });
            });
        });
        deleteFolders.then(() => {
            console.log('Deleted folders');
        });
        deleteFolders.catch(err => {
            console.log(err);
        });            
    });
    fillMetrics.catch(err => {
        console.log(err);
    });
}

app.get('/metrics', async (req, res) => {
    res.setHeader('Content-Type', register.contentType);
    res.send(await register.metrics());
});

app.get('/raws/:file', async (req, res) => {
    res.setHeader('Content-Type', register.contentType);
    // send file from pvpath directory
    res.sendFile(path.join(pvpath, req.params.file));
});

//// MITM to catch raws sent to cloud, implementation stopped for using PV with RWX
//
//app.post('/api/ingress/v1/upload', (req, res) => {
//    console.log('Uploading ingress');
//    // save file to ./extracted/
//    var file = req.files.file;
//    console.log("file: " + file);
//
//    var fileName = file.name;
//    console.log("fileName: " + fileName);
//    var filePath = './raws/' + fileName;
//    file.mv(filePath, (err) => {
//        if (err) {
//            console.log(err);
//        }
//        else {
//            console.log('File uploaded');
//            res.send({
//                status: true,
//                message: 'File is uploaded'
//            });
//            untarFilesWithGracePeriod();
//        }
//    });
//});
//
//app.get('/api/sources/v1.0/source_type', async (req, res) => {
//    // resend same req to other server
//    console.log(req);
//});