# JavaScript Tracking Plan


## Advisory SE Roundtable

<!-- tabs:start -->
### **Details**

#### **Description**

Advisory SE Roundtab
#### **Properties**

| **Name** | `Type` | Description | Required? |
| :--- | :--- | :--- | :--- |
| **prop2** | `string` | this is a single property | ✅ |
| **prop3** | `string` | this is a single property | ✅ |
#### **JS**

```javascript
analytics.track("Advisory SE Roundtable", {
  "prop2": "<<type: string, required: true>>",
  "prop3": "<<type: string, required: true>>"
})
```

<!-- tabs:end -->

<!-- panels:end -->


## Aubrey's Event 1

<!-- tabs:start -->
### **Details**

#### **Description**

Aubrey's Event 1000
#### **Properties**

| **Name** | `Type` | Description | Required? |
| :--- | :--- | :--- | :--- |
| **prop22** | `string` | this is a single property | ✅ |
#### **JS**

```javascript
analytics.track("Aubrey's Event 1", {
  "prop22": "<<type: string, required: true>>"
})
```

<!-- tabs:end -->

<!-- panels:end -->


## First Event

<!-- tabs:start -->
### **Details**

#### **Description**

First Event description 10
#### **Properties**

| **Name** | `Type` | Description | Required? |
| :--- | :--- | :--- | :--- |
| **array_prop22** | `array` | this is an array property (it will specify  "items", keys that need to exist for each item in the array) | ❌ |
| **array_prop22.items** | `object` | Contains the structure for array items | ❌ |
| **array_prop22.items.layer1_prop34** | `string` | this is an optional property on any items in the array_prop1  change here | ❌ |
| **obj_prop1** | `object` | this is required object (i.e. can have nested sub-properties) here here | ✅ |
| **obj_prop1.sub_prop1** | `array` | here blach | ❌ |
| **prop3** | `string` | this is a single test testing | ✅ |
#### **JS**

```javascript
analytics.track("First Event", {
  "array_prop22": [
    {
      "layer1_prop34": "<<type: string, required: false>>"
    }
  ],
  "obj_prop1": {
    "sub_prop1": "<<type: array, required: false>>"
  },
  "prop3": "<<type: string, required: true>>"
})
```

<!-- tabs:end -->

<!-- panels:end -->


## Obj Prop

<!-- tabs:start -->
### **Details**

#### **Description**

Obj Prop
#### **Properties**

| **Name** | `Type` | Description | Required? |
| :--- | :--- | :--- | :--- |
| **object** | `object` | this is a single property | ✅ |
| **object.int1** | `number` | this should be a new property sd safd | ❌ |
| **object.string** | `string` | this is a required sub-property in an object | ❌ |
| **object2** | `object` | this is a single property | ❌ |
| **object2.string** | `string` | this is a required sub-property in an object | ❌ |
#### **JS**

```javascript
analytics.track("Obj Prop", {
  "object": {
    "int1": "<<type: number, required: false>>",
    "string": "<<type: string, required: false>>"
  },
  "object2": {
    "string": "<<type: string, required: false>>"
  }
})
```

<!-- tabs:end -->

<!-- panels:end -->


## Obj Prop 10

<!-- tabs:start -->
### **Details**

#### **Description**

Obj Prop 10
#### **Properties**

| **Name** | `Type` | Description | Required? |
| :--- | :--- | :--- | :--- |
| **object** | `object` | this is a single property | ✅ |
| **object.int1** | `number` | this should be a new property | ❌ |
| **object.string** | `string` | this is a required property in an object new descriotion | ❌ |
| **object2** | `object` | this is a single property | ❌ |
| **object2.string** | `string` | this is a required sub-property in an object dsfa | ❌ |
#### **JS**

```javascript
analytics.track("Obj Prop 10", {
  "object": {
    "int1": "<<type: number, required: false>>",
    "string": "<<type: string, required: false>>"
  },
  "object2": {
    "string": "<<type: string, required: false>>"
  }
})
```

<!-- tabs:end -->

<!-- panels:end -->


## Obj Prop 2

<!-- tabs:start -->
### **Details**

#### **Description**

Obj Prop 2 description
#### **Properties**

| **Name** | `Type` | Description | Required? |
| :--- | :--- | :--- | :--- |
| **object** | `object` | this is a single property | ✅ |
| **object.int1** | `number` | this should be a new property | ❌ |
| **object.string** | `string` | this is a required property in an object new descriotion | ❌ |
| **object2** | `object` | this is a single property | ❌ |
| **object2.string** | `string` | this is a required sub-property in an object dsfa | ❌ |
#### **JS**

```javascript
analytics.track("Obj Prop 2", {
  "object": {
    "int1": "<<type: number, required: false>>",
    "string": "<<type: string, required: false>>"
  },
  "object2": {
    "string": "<<type: string, required: false>>"
  }
})
```

<!-- tabs:end -->

<!-- panels:end -->


## Obj Prop 20

<!-- tabs:start -->
### **Details**

#### **Description**

Obj Prop 20
#### **Properties**

| **Name** | `Type` | Description | Required? |
| :--- | :--- | :--- | :--- |
| **object** | `object` | this is a single property | ✅ |
| **object.int1** | `number` | this should be a new property | ❌ |
| **object.string** | `string` | this is a required property in an object new descriotion | ❌ |
| **object2** | `object` | this is a single property | ❌ |
| **object2.string** | `string` | this is a required sub-property in an object dsfa | ❌ |
#### **JS**

```javascript
analytics.track("Obj Prop 20", {
  "object": {
    "int1": "<<type: number, required: false>>",
    "string": "<<type: string, required: false>>"
  },
  "object2": {
    "string": "<<type: string, required: false>>"
  }
})
```

<!-- tabs:end -->

<!-- panels:end -->


## Obj Prop 22

<!-- tabs:start -->
### **Details**

#### **Description**

Obj Prop 22
#### **Properties**

| **Name** | `Type` | Description | Required? |
| :--- | :--- | :--- | :--- |
| **object** | `object` | this is a single property | ✅ |
| **object.int1** | `number` | this should be a new property | ❌ |
| **object.string** | `string` | this is a required property in an object new descriotion | ❌ |
| **object2** | `object` | this is a single property | ❌ |
| **object2.string** | `string` | this is a required sub-property in an object dsfa | ❌ |
#### **JS**

```javascript
analytics.track("Obj Prop 22", {
  "object": {
    "int1": "<<type: number, required: false>>",
    "string": "<<type: string, required: false>>"
  },
  "object2": {
    "string": "<<type: string, required: false>>"
  }
})
```

<!-- tabs:end -->

<!-- panels:end -->


## Obj Prop 4

<!-- tabs:start -->
### **Details**

#### **Description**

Obj Prop 4 description
#### **Properties**

| **Name** | `Type` | Description | Required? |
| :--- | :--- | :--- | :--- |
| **object** | `object` | this is a single property | ✅ |
| **object.int1** | `number` | this should be a new property | ❌ |
| **object.string** | `string` | this is a required property in an object new descriotion | ❌ |
| **object2** | `object` | this is a single property | ❌ |
| **object2.string** | `string` | this is a required sub-property in an object dsfa | ❌ |
#### **JS**

```javascript
analytics.track("Obj Prop 4", {
  "object": {
    "int1": "<<type: number, required: false>>",
    "string": "<<type: string, required: false>>"
  },
  "object2": {
    "string": "<<type: string, required: false>>"
  }
})
```

<!-- tabs:end -->

<!-- panels:end -->


## Obj Prop 6

<!-- tabs:start -->
### **Details**

#### **Description**

Obj Prop 6
#### **Properties**

| **Name** | `Type` | Description | Required? |
| :--- | :--- | :--- | :--- |
| **object** | `object` | this is a single property | ✅ |
| **object.int1** | `number` | this should be a new property | ❌ |
| **object.string** | `string` | this is a required property in an object new descriotion | ❌ |
| **object2** | `object` | this is a single property | ❌ |
| **object2.string** | `string` | this is a required sub-property in an object dsfa | ❌ |
#### **JS**

```javascript
analytics.track("Obj Prop 6", {
  "object": {
    "int1": "<<type: number, required: false>>",
    "string": "<<type: string, required: false>>"
  },
  "object2": {
    "string": "<<type: string, required: false>>"
  }
})
```

<!-- tabs:end -->

<!-- panels:end -->


## Second Event

<!-- tabs:start -->
### **Details**

#### **Description**

Second Event
#### **Properties**

| **Name** | `Type` | Description | Required? |
| :--- | :--- | :--- | :--- |
| **array_prop1** | `array` | this is an array property (it will specify  "items", keys that need to exist for each item in the array) | ❌ |
| **array_prop1.items** | `object` | Contains the structure for array items | ❌ |
| **array_prop1.items.layer1_prop217** | `string` | this is an o ptional property on any items in the array_prop1 array safd | ❌ |
| **obj_prop1** | `object` | tfhis is required obj ect (i.e. c an have nested sub-properties) | ✅ |
| **obj_prop1.sub_prop1** | `string` | this is a req uired sub-property in an object | ❌ |
| **prop3** | `string` | this is a single property | ✅ |
#### **JS**

```javascript
analytics.track("Second Event", {
  "array_prop1": [
    {
      "layer1_prop217": "<<type: string, required: false>>"
    }
  ],
  "obj_prop1": {
    "sub_prop1": "<<type: string, required: false>>"
  },
  "prop3": "<<type: string, required: true>>"
})
```

<!-- tabs:end -->

<!-- panels:end -->


## Segment Consent Preference Updated

<!-- tabs:start -->
### **Details**

#### **Description**

Segment Consent Preference Updated
#### **Properties**

| **Name** | `Type` | Description | Required? |
| :--- | :--- | :--- | :--- |
#### **JS**

```javascript
analytics.track("Segment Consent Preference Updated", {})
```

<!-- tabs:end -->

<!-- panels:end -->


## Third Event

<!-- tabs:start -->
### **Details**

#### **Description**

Third Event
#### **Properties**

| **Name** | `Type` | Description | Required? |
| :--- | :--- | :--- | :--- |
| **prop2** | `string` | this is a single property | ✅ |
#### **JS**

```javascript
analytics.track("Third Event", {
  "prop2": "<<type: string, required: true>>"
})
```

<!-- tabs:end -->

<!-- panels:end -->
