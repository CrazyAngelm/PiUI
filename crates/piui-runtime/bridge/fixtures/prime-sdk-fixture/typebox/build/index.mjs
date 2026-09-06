export const Type={Union:(anyOf)=>({anyOf}),Object:(properties,options={})=>({type:"object",properties,...options}),Literal:(constValue)=>({const:constValue}),String:()=>({type:"string"})};
