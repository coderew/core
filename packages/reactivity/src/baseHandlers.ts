import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  isReadonly,
  isShallow
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  /*#__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    // ios10.x Object.getOwnPropertyNames(Symbol) can enumerate 'arguments' and 'caller'
    // but accessing them on Symbol leads to TypeError because Symbol is a strict mode
    // function
    .filter(key => key !== 'arguments' && key !== 'caller')
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
  // instrument identity-sensitive Array methods to account for possible reactive
  // values
  // 重写数组的查找方法
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // toRaw 通过代理对象的 raw 属性读取原始数组对象
      const arr = toRaw(this) as any
      // 遍历数组，按照数组的下标收集依赖
      for (let i = 0, l = this.length; i < l; i++) {
        // 收集依赖
        track(arr, TrackOpTypes.GET, i + '')
      }
      // we run the method using the original args first (which may be reactive)
      const res = arr[key](...args)
      if (res === -1 || res === false) {
        // 没有找到对应的值，args 有可能是包装后的响应式数据，因此获取原始数据后再尝试去查询
        // if that didn't work, run it again using raw values.
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })
  // instrument length-altering mutation methods to avoid length being tracked
  // which leads to infinite loops in some cases (#2137)
  // 重写 改变数组长度的方法
  // push/pop/shift/unshift 以及splice 方法会隐式地修改数组长度
  // 这些方法在执行的过程中，既会读取数组的 length 属性值，也会设置数组的 length 属性值
  // 因此需要重写这些方法，屏蔽对 length 属性的读取，从而避免在它与副作用函数之间建立响应联系。
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // 执行前禁用依赖收集，
      /**
       * 这里主要是为了避免改变数组长度时，会set length，形成track - trigger的死循环
       * 因此要暂停改变数组长度时的执行期间收集依赖
       */
      pauseTracking()
      const res = (toRaw(this) as any)[key].apply(this, args)
      // 在调用原始方法之后，恢复原来的行为，即允许追踪
      resetTracking()
      return res
    }
  })
  return instrumentations
}

function hasOwnProperty(this: object, key: string) {
  const obj = toRaw(this)
  track(obj, TrackOpTypes.HAS, key)
  return obj.hasOwnProperty(key)
}

class BaseReactiveHandler implements ProxyHandler<Target> {
  constructor(
    protected readonly _isReadonly = false,
    protected readonly _shallow = false
  ) {}

  get(target: Target, key: string | symbol, receiver: object) {
    const isReadonly = this._isReadonly,
      shallow = this._shallow
    // 注意：此处的if判断逻辑处理Vue内部定义的ReactiveFlags，是先处理响应式对象标志位的逻辑
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      // 是否是只读
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      // 是否是浅响应
      return shallow
    } else if (key === ReactiveFlags.RAW) {
      if (
        receiver ===
          (isReadonly
            ? shallow
              ? shallowReadonlyMap
              : readonlyMap
            : shallow
              ? shallowReactiveMap
              : reactiveMap
          ).get(target) ||
        // receiver is not the reactive proxy, but has the same prototype
        // this means the reciever is a user proxy of the reactive proxy
        Object.getPrototypeOf(target) === Object.getPrototypeOf(receiver)
      ) {
        // 返回响应式对象的原始值
        return target
      }
      // early return undefined
      return
    }

    const targetIsArray = isArray(target)
    // 对数组属性读取的拦截操作
    if (!isReadonly) {
      if (targetIsArray && hasOwn(arrayInstrumentations, key)) {
        return Reflect.get(arrayInstrumentations, key, receiver)
      }
      if (key === 'hasOwnProperty') {
        return hasOwnProperty
      }
    }
    // 读取key对应的属性值，第三个参数receiver可以帮助分析this指向的是谁
    const res = Reflect.get(target, key, receiver)
    // key是symbol或访问的是__proto__属性不做依赖收集和递归响应式转化，直接返回结果
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }
    // 只读属性值不会发生变化，无法触发setter，因此，target是非只读时才需要收集依赖
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }
    // 如果是浅响应，则直接返回原始值的结果
    if (shallow) {
      return res
    }
    // 如果是ref对象，则unwrap
    if (isRef(res)) {
      // ref unwrapping - skip unwrap for Array + integer key.
      return targetIsArray && isIntegerKey(key) ? res : res.value
    }
    // 如果原始值结果是一个对象，则继续包装成响应式数据
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

class MutableReactiveHandler extends BaseReactiveHandler {
  constructor(shallow = false) {
    super(false, shallow)
  }
  // set操作符的拦截
  set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object
  ): boolean {
    let oldValue = (target as any)[key]
    // 深度代理的情况
    if (!this._shallow) {
      const isOldValueReadonly = isReadonly(oldValue)
      if (!isShallow(value) && !isReadonly(value)) {
        // 防止如果后面操作了value，引起二次setter
        oldValue = toRaw(oldValue)
        value = toRaw(value)
      }
      // target是对象且值为ref类型，当对这个值修改的时候应该修改ref.value
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        if (isOldValueReadonly) {
          return false
        } else {
          oldValue.value = value
          return true
        }
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }
    // 判断当前访问的key是否存在，不存在则是设置新的值
    const hadKey =
      // 当前的target为数组且访问的是数字
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    // 设置值
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    if (target === toRaw(receiver)) {
      // 设置新的值
      if (!hadKey) {
        // 操作类型是ADD，触发响应
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        // 操作类型是SET，修改老的值，触发响应
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }

  deleteProperty(target: object, key: string | symbol): boolean {
    // 判断删除的属性是否存在
    const hadKey = hasOwn(target, key)
    // 获取旧值
    const oldValue = (target as any)[key]
    // 删除属性返回值为是否删除成功
    const result = Reflect.deleteProperty(target, key)
    if (result && hadKey) {
      // 只有被删除属性时对象自己的属性并且成功删除的时候，触发更新
      trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
    }
    return result
  }
  // 拦截in操作符
  has(target: object, key: string | symbol): boolean {
    const result = Reflect.has(target, key)
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
      // 依赖收集
      track(target, TrackOpTypes.HAS, key)
    }
    return result
  }
  // for ... in 循环拦截
  ownKeys(target: object): (string | symbol)[] {
    // 如果操作目标target是数组，则用length属性作为key建立响应，否则使用ITERATE_KEY建立响应联系
    track(
      target,
      TrackOpTypes.ITERATE,
      isArray(target) ? 'length' : ITERATE_KEY
    )
    return Reflect.ownKeys(target)
  }
}

class ReadonlyReactiveHandler extends BaseReactiveHandler {
  constructor(shallow = false) {
    super(true, shallow)
  }

  set(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }

  deleteProperty(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

export const mutableHandlers: ProxyHandler<object> =
  /*#__PURE__*/ new MutableReactiveHandler()

export const readonlyHandlers: ProxyHandler<object> =
  /*#__PURE__*/ new ReadonlyReactiveHandler()

export const shallowReactiveHandlers = /*#__PURE__*/ new MutableReactiveHandler(
  true
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers =
  /*#__PURE__*/ new ReadonlyReactiveHandler(true)
