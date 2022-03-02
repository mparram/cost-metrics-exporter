var key = "penshift-ovirt-infra|metricUsageCpuCoreSeconds|hour|2022-03-01 04:00:00 +0000 UTC|app|ovirt-infra-mdns";
var lineData = key.split('|');
console.log("1: " + lineData[5]);
var key2 = "penshift-ovirt-infra|metricUsageCpuCoreSeconds|hour|2022-03-01 04:00:00 +0000 UTC";
var lineData2 = key2.split('|');
console.log("2: " + lineData2[5]);
if (lineData2[5] !== null) {
    console.log("true");
} else {
    console.log("false");
}