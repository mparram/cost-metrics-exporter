# COST-METRICS Exporter

This is a NodeJS application designed to publish an endpoint with metrics based on data collected by cost-manamagement Operator in Openshift Container Platform.

***DISCLAIMER***: it was designed for experimental purposes and is not supported or recommended for use in production environments.


## Prerequisites

This app require to use the same PV as costmanagement-metrics-controller-manager pod, so it's required to use the persistent volume with ReadWriteMany mode, take a look to the manifests and be sure that you can use them in your platform.


## Install

To install it you need to be clusteradmin, and it's going to deploy in ***costmanagement-metrics-operator*** Project

### **(A)** Build with s2i:

```
oc apply -f manifests/
```