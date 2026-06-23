async function hasArrayType( arr ) {
  if( arr.length == 0 ) return false;
  let t = typeof arr[0];
  var n = await digitType(arr[0]);
  var i=0, y;
  //console.log("length=" + arr.length);
  y = await digitType(arr[0]);
  //console.log("arr[" + i + "] = " + typeof arr[i] + ":" + y);
  for( i=1; i<arr.length; i++ ) {
    //console.log("trying " + i);
    try {
      y = await digitType(arr[i]);
      if( ( t != (typeof arr[i]) ) || ( n != y ) ) {
        return false;
      } else {
        //console.log("arr[" + i + "] = " + typeof arr[i] + ":" + y);
      }
    } catch( e ) {
      //console.log("failure looking at type");
    }
    //console.log("finished " + i);
  }
  return t;
}

let last_ten_types = [];
export async function digitType( obj ) {
  const typestr = typeof obj;
  var arrtype, result;
  
  if( typestr == 'string' ) {
    if( obj.length <= 16000 ) {
      result = 0x01; // "short" string
    } else {
      result = 0x11; // long string
    }
  } else if( typestr == 'number' || typestr == 'boolean' ) {
    if( parseInt(obj) == obj ) {
      if( Math.abs(obj) < 16000 ) {
        result = 0x02; // int16
      } else {
        result = 0x12; // int32
      }
    } else {
      result = 0x22; // float
    }
  } else if( obj instanceof Uint16Array ) {
    if( obj.length <= 16000 ) {
      result = 0x03; // "short" u16array
    } else {
      result = 0x13; // "long" u16array
    }
  } else if( Array.isArray(obj) ) {
    arrtype = await hasArrayType(obj);
    if( obj.length <= 16000 ) {
      if( arrtype !== false ) {
        result = 0x10; // short typed array
      } else {
        result = 0x20; // short untyped array
      }
    } else {
      if( arrtype !== false ) {
        result = 0x30; // typed array, large
      } else {
        result = 0x40; // untyped array, large
      }
    }
  } else if( obj && (typestr==="array" || typestr === "object") && !ArrayBuffer.isView(obj) ) {
    result = 0x15;
  } else {
    result = 0x99;
    //console.log("Type 0x99! Last ten: " + last_ten_types.join(","));
  }
  
  last_ten_types.push(result);
  if( last_ten_types.length > 10 ) last_ten_types.shift();
  return result;
}
export async function bin_encode(value) {
  const chunks = [];
  const tmpBuf = new ArrayBuffer(8);
  const view = new DataView(tmpBuf); // temp for numbers
  
  let text_trace = '';
  
  function writeUint16(n) {
    view.setUint16(0, n, true);
    chunks.push(new Uint8Array(tmpBuf.slice(0,2), 0, 2));
    text_trace += "u16:" + n + ",";
  }
  
  function writeUint32(n) {
    view.setUint32(0, n, true);
    chunks.push(new Uint8Array(tmpBuf.slice(0,4), 0, 4));
    text_trace += "u32:" + n + ",";
  }

  function writeFloat64(n) {
    view.setFloat64(0, n, true);
    chunks.push(new Uint8Array(tmpBuf.slice(0,8), 0, 8));
    text_trace += "f64:" + n + ",";
  }

  async function writeBytes(bytes) {
    if( !(bytes instanceof Uint8Array) ) {
      //console.log("Write string: " + bytes);
    }
    let data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    chunks.push(data);
    text_trace += "bytes(" + bytes.length + "),";
  }

  async function encodeValue(v, includeType=true) {
    var arrtype, utf8;
    let tn = await digitType(v);
    text_trace += "encode type 0x" + tn.toString(16);
    
    if( tn == 0x99 ) {
      //console.log("Unknown object " + typeof v + ": ", v);
      return false;
    }
    
    if( includeType ) {
      text_trace += "type:" + tn + "\n";
      writeUint16(tn);
    }
    
    switch( tn ) {
      case 0x01: // short string
        utf8 = new TextEncoder().encode(v);
        writeUint16(utf8.length);
        writeBytes(utf8);
        break;
      case 0x11: // long string
        utf8 = new TextEncoder().encode(v);
        writeUint32(utf8.length);
        writeBytes(utf8);
        break;
      case 0x02: // int < 16000
        writeUint16(v);
        break;
      case 0x12: // int >= 16000
        writeUint32(v);
        break;
      case 0x22: // float
        writeFloat64(v);
        break;
      case 0x03: // short u16array
        writeUint16(v.length);
        writeBytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        break;
      case 0x13: // long u16array
        writeUint32(v.length);
        writeBytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        break;
      case 0x10: // typed Array
        writeUint16(v.length);
        if( v.length != 0 ) {
          var t = await digitType(v[0]);
          var typename = typeof v[0];
          writeUint16(t);
          
          text_trace += "write array " + t + "*" + v.length + "\n";
          //console.log("write array " + t + "*" + v.length + "\n");
          let k = new Set(), y;
          for( var obj in v )
            k.add(obj);
            
          for( var x=0; x<v.length; x++ ) {
            if( !k.has(''+x) ) {
              console.error("Unexpected item");
              throw "not likely";
            }
            
            y = await digitType(v[x]);
            if( y != t ) {
              //console.log("Invalid type " + t + "(" + typename + ") is not same as " + typeof v[x] + ":" + y);
              throw "error";
            }
          }
          
          //console.log(k.size + " items of " + v.length);
          for( var item=0; item<v.length; item++ )
          {
            let Item = '' + item;
            if( k.has(Item) ) {
              k.delete(Item);
              if( !(await encodeValue(v[item], false)) )
                return false;
            } else {
              //console.log("Missing array item " + item + "/" + v.length);
            }
          }
          if( k.size != 0 ) {
            //console.log("unexpected", k.entries());
          }
          text_trace += "\narray complete\n";
        }
        break;
      case 0x20: // untyped array
        writeUint16(v.length);
        text_trace += "write array*" + v.length;
        for (const item of v)
        {
          if( !(await encodeValue(item)) )
            return false;
        }
        text_trace += "write array complete";
        break;
      case 0x30: // typed Array, large
        writeUint32(v.length);
        var t = await digitType(v[0]);
        writeUint16(t);
        text_trace += "write array " + t + "x" + v.length;
        ////console.log(("Write type 0x30 " + digitType(v[0]) + " * " + v.length));
        for( var item=0; item<v.length; item++ ) 
        {
          if( !(await encodeValue(v[item], false) ) )
            return false;
        }
        text_trace += "write array complete";
        break;
      case 0x40: // untyped array, large
        writeUint32(v.length);
        text_trace += "write array ux" + v.length;
        for (const item of v)
        {
          if( !(await encodeValue(item)) )
            return false;
        }
        text_trace += "write array complete";
        break;
      case 0x15: // object
        const entries = Object.entries(v);
        writeUint16(entries.length);
        for (const [k, val] of entries)
        {
          const keyBytes = new TextEncoder().encode(String(k));
          writeUint16(keyBytes.length);
          writeBytes(keyBytes);
          if( !(await encodeValue(val)) )
            return false;
        }
        break;
    }
    return true;
  }
  
  if( !(await encodeValue(value)) ) {
    return null;
  }

  // Concatenate all chunks
  let totalLen = chunks.reduce((sum, b) => sum + b.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    if( offset < 8 ) {
      let buf = '';
      for( var s of chunk ) {
        buf += "0x" + s.toString(16);
      }
      ////console.log("write byte: ", buf);
    }
    result.set(chunk, offset);
    offset += chunk.length;
  }

  ////console.log(text_trace);
  return result;
}

export async function bin_decode(buffer) {
  if (!(buffer instanceof Uint8Array)) {
    throw new Error("Input must be Uint8Array");
  }

  let pos = 0;
  let last_read_types=[];

  function readUint16() {
    if (pos + 2 > buffer.length) throw new Error("Unexpected end (uint16)");
    const v = buffer[pos] | (buffer[pos+1]<<8);
    pos += 2;
    return v >>> 0; // to unsigned
  }
  
  function readUint32() {
    if (pos + 4 > buffer.length) throw new Error("Unexpected end (uint32)");
    const v = buffer[pos] | (buffer[pos+1]<<8) | (buffer[pos+2]<<16) | (buffer[pos+3]<<24);
    pos += 4;
    return v >>> 0; // to unsigned
  }

  function readFloat64() {
    if (pos + 8 > buffer.length) throw new Error("Unexpected end (float64)");
    const dv = new DataView(buffer.buffer, buffer.byteOffset + pos, 8);
    const v = dv.getFloat64(0, true);
    pos += 8;
    return v;
  }

  async function readString() {
    const len = readUint16();
    if (pos + len > buffer.length) throw new Error("Unexpected end (string)");
    const bytes = await buffer.subarray(pos, pos + len);
    pos += len;
    var str = await new TextDecoder().decode(bytes);
    ////console.log("Read string " + str);
    return str;
  }
  
  async function readLongString() {
    const len = readUint32();
    if (pos + len > buffer.length) throw new Error("Unexpected end (string)");
    const bytes = await buffer.subarray(pos, pos + len);
    pos += len;
    return await new TextDecoder().decode(bytes);
  }
  
  
  
  

  async function decodeValue(tn=null) {
    var count, arr, len, byteLen, arrtyped;
    
    if (pos >= buffer.length) throw new Error("Unexpected end of buffer");

    if( tn === null ) {
      tn = readUint16();
      
      //console.log("Read type 0x" + tn.toString(16).padStart(2,'0'));
    }
    
    switch (tn) {
      case 0x01: // short string
        return await readString();
      case 0x11: // long string
        return await readLongString();
      case 0x02:
        return readUint16();
      case 0x12:
        return readUint32();
      case 0x22:
        return readFloat64();
      case 0x03: // Uint16Array, small
        len = readUint16();
        byteLen = len * 2;
        if (pos + byteLen > buffer.length) throw new Error("Unexpected end (uint16array)");
        arr = new Uint16Array(len);
        for( var q=0;q<len; q++ ) {
          arr[q] = buffer.buffer[pos] | (buffer.buffer[pos+1]<<8);
          pos += 2;
        }
        return arr;
      case 0x13: // Uint16Array, large
        len = readUint32();
        byteLen = len * 2;
        if (pos + byteLen > buffer.length) throw new Error("Unexpected end (uint16array)");
        arr = new Uint16Array(len);
        for( var q=0;q<len; q++ ) {
          arr[q] = buffer.buffer[pos] | (buffer.buffer[pos+1]<<8);
          pos += 2;
        }
        return arr;
      case 0x10: // short typed Array
        count = readUint16();
        if( count == 0 ) {
          arr = [];
        } else {
          arrtyped = readUint16();
          arr = new Array(count);
          //console.log("read 0x10 " + arrtyped + " * " + count);
          for (let i = 0; i < count; i++) {
            arr[i] = await decodeValue(arrtyped);
            //console.log("arr[" + i + "]=", arr[i]);
          }
        }
        //console.log("array length: " + arr.length);
        return arr;
      case 0x20: // short untyped Array
        count = readUint16();
        arr = new Array(count);
        //console.log("read 0x20 * " + count);
        for (let i = 0; i < count; i++) {
          arr[i] = await decodeValue();
        }
        return arr;
      case 0x30: // long typed Array
        count = readUint32();
        if( count === 0 ) {
          arr = [];
        } else {
          arrtyped = readUint16();
          arr = new Array(count);
          //console.log("read 0x30 " + arrtyped + " * " + count);
          for (let i = 0; i < count; i++) {
            arr[i] = await decodeValue(arrtyped);
          }
        }
        return arr;
      case 0x40: // long untyped Array
        count = readUint32();
        arr = new Array(count);
        for (let i = 0; i < count; i++) {
          arr[i] = await decodeValue();
        }
        return arr;
      case 0x15: // object
        count = readUint16();
        const obj = {};
        for (let i = 0; i < count; i++) {
          const keyLen = readUint16();
          ////console.log("key length: " + keyLen);
          if (pos + keyLen > buffer.length) throw new Error("Unexpected end (key)");
          const keyBytes = buffer.subarray(pos, pos + keyLen);
          pos += keyLen;
          const key = await new TextDecoder().decode(keyBytes);
          ////console.log("read key: " + key);
          obj[key] = await decodeValue();
          ////console.log("value: ", obj[key]);
        }
        return obj;
      default:
        let ebuf = tn.toString(16);
        throw `Unknown type byte: 
        ${ebuf} at ${pos}/${buffer.length}`;
        
    }
  }

  const result = await decodeValue();
  if (pos !== buffer.length) {
    throw new Error(`Extra bytes after parsing (${pos}/${buffer.length})`);
  }
  return result;
}

// example use:
export async function binaryTest()
{
  var i;
  const example = {
    name: "João Café",
    scores: new Uint16Array([65535, 32768, 0]),
    pi: Math.PI,
    items: ["a", "β", 42, new Uint16Array([100, 200])],
    meta: { active: true, level: 99 }
  };
  
  let longArray = [];
  for( i=0; i<14000; i++ ) {
    longArray[i] = i;
  }
  example.longArray = longArray.slice();
  
  for( ; i<140000; i++ ) {
    longArray[i] = i;
  }
  example.veryLongArray = longArray;
  
  let longString = '';
  for( i=0; i<60000; i++ ) {
   longString += String.fromCharCode(i%256);
  }
  example.longString = longString;
  //console.log("Encode: ", example);
  
  const buf = await bin_encode(example);
  //console.log(`Encoded size: ${buf.length} bytes`);
  
  const restored = await bin_decode(buf);
  
  for( i=0; i<restored.longArray.length; i++ ) {
    if( restored.longArray[i] != i ) {
      throw "Error at longArray[" + i + "]";
    }
  }
  for( i=0; i<restored.longString.length; i++ ) {
    if( restored.longString.charCodeAt(i) != i%256 ) {
      throw "Error at longString[" + i + "]";
    }
  }
  delete restored.longString;
  delete restored.longArray;
  //console.log(restored);
  //console.log("Passing:",restored.scores instanceof Uint16Array); // true
  return true;
}
